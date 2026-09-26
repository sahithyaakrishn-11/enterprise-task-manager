
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;
use std::env;
use std::time::Duration;

use krafka::consumer::{AutoOffsetReset, Consumer};
use krafka::producer::Producer;
use tower_http::cors::CorsLayer;
use dotenvy::dotenv;

mod worker;
use axum::{
    extract::{Path, State},
    http::{Request, StatusCode},
    middleware::{self, Next},
    routing::{get, post, put},
    Json, Router,
};

use jsonwebtoken::{decode, decode_header, DecodingKey, Validation};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sqlx::{postgres::PgPoolOptions, FromRow};
use tokio::net::TcpListener;

use opensearch::{
    http::transport::Transport,
    OpenSearch,
};


#[derive(Serialize, Deserialize, FromRow, utoipa::ToSchema)]
struct Task {
    id: i32,
    title: String,
}


#[derive(Deserialize, utoipa::ToSchema)]
struct CreateTask {
    title: String,
}


#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct Claims {
    sub: String,
    preferred_username: Option<String>,
    exp: usize,
}


#[derive(OpenApi)]
#[openapi(
    paths(
        create_task,
        get_tasks,
        update_task,
        delete_task
    ),
    components(
        schemas(Task, CreateTask)
    )
)]
struct ApiDoc;


const JWKS_URL: &str =
    "http://localhost:8080/realms/enterprise-task-manager/protocol/openid-connect/certs";


#[derive(Debug, Deserialize)]
struct Jwk {
    kid: String,
    n: String,
    e: String,
}


#[derive(Debug, Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}


async fn get_jwks() -> Result<Jwks, String> {
    let client = Client::new();

    client
        .get(JWKS_URL)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<Jwks>()
        .await
        .map_err(|e| e.to_string())
}


async fn verify_token(token: &str) -> Result<Claims, String> {
    let header = decode_header(token)
        .map_err(|e| e.to_string())?;

    let kid = header
        .kid
        .ok_or("Token does not contain kid")?;

    let jwks = get_jwks().await?;

    let key = jwks
        .keys
        .iter()
        .find(|key| key.kid == kid)
        .ok_or("Matching key not found")?;

    let decoding_key =
        DecodingKey::from_rsa_components(&key.n, &key.e)
            .map_err(|e| e.to_string())?;

    let mut validation =
        Validation::new(jsonwebtoken::Algorithm::RS256);

    validation.set_issuer(&[
        "http://localhost:8080/realms/enterprise-task-manager",
        "http://10.0.2.2:8080/realms/enterprise-task-manager",
    ]);

    validation.validate_aud = false;

    let token_data = decode::<Claims>(
        token,
        &decoding_key,
        &validation,
    )
    .map_err(|e| e.to_string())?;

    Ok(token_data.claims)
}


async fn auth_middleware(
    request: Request<axum::body::Body>,
    next: Next,
) -> Result<axum::response::Response, StatusCode> {

    let auth_header = request
        .headers()
        .get("Authorization")
        .and_then(|value| value.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let token = auth_header
        .strip_prefix("Bearer ")
        .ok_or(StatusCode::UNAUTHORIZED)?;

    match verify_token(token).await {
        Ok(_) => {}

        Err(error) => {
            println!("JWT verification failed: {}", error);
            return Err(StatusCode::UNAUTHORIZED);
        }
    }

    Ok(next.run(request).await)
}


// ======================================================
// SHARED APPLICATION STATE
// ======================================================

#[derive(Clone)]
struct AppState {
    pool: sqlx::PgPool,
    redis: redis::Client,
    opensearch: opensearch::OpenSearch,
}


// ======================================================
// CREATE TASK
// ======================================================

#[utoipa::path(
    post,
    path = "/tasks",
    request_body = CreateTask,
    responses(
        (status = 200, description = "Task created", body = Task)
    )
)]
async fn create_task(
    State(state): State<AppState>,
    Json(payload): Json<CreateTask>,
) -> Result<Json<Task>, StatusCode> {
    let task = sqlx::query_as::<_, Task>(
        "INSERT INTO tasks (title) VALUES ($1) RETURNING id, title",
    )
    .bind(&payload.title)
    .fetch_one(&state.pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Store task in Redis
    let mut redis_conn = state
        .redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let key = format!("task:{}", task.id);

    let _: () = redis::cmd("SET")
        .arg(&key)
        .arg(&task.title)
        .query_async(&mut redis_conn)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Index task in OpenSearch
    if let Err(error) = index_task(&state.opensearch, &task).await {
        println!("OpenSearch indexing failed: {}", error);
    }

    // Send Kafka event
    println!("Task created: {}", task.id);

    Ok(Json(task))
}

// ======================================================
// GET TASKS
// ======================================================

#[utoipa::path(
    get,
    path = "/tasks",
    responses(
        (status = 200, description = "List of tasks", body = [Task])
    )
)]
async fn get_tasks(
    State(state): State<AppState>,
) -> Result<Json<Vec<Task>>, String> {

    // Check Redis cache
    let mut redis_connection = state
        .redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| e.to_string())?;

    let cached: Option<String> = redis::cmd("GET")
        .arg("tasks")
        .query_async(&mut redis_connection)
        .await
        .map_err(|e| e.to_string())?;

    if let Some(cached_tasks) = cached {
        let tasks: Vec<Task> =
            serde_json::from_str(&cached_tasks)
                .map_err(|e| e.to_string())?;

        return Ok(Json(tasks));
    }


    // Query PostgreSQL
    let tasks = sqlx::query_as::<_, Task>(
        "SELECT id, title FROM tasks ORDER BY id",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;


    // Store in Redis
    let json = serde_json::to_string(&tasks)
        .map_err(|e| e.to_string())?;

    redis::cmd("SETEX")
        .arg("tasks")
        .arg(30)
        .arg(json)
        .query_async::<()>(&mut redis_connection)
        .await
        .map_err(|e| e.to_string())?;


    Ok(Json(tasks))
}


// ======================================================
// UPDATE TASK
// ======================================================

#[utoipa::path(
    put,
    path = "/tasks/{id}",
    params(
        ("id" = i32, Path, description = "Task ID")
    ),
    request_body = CreateTask,
    responses(
        (status = 200, description = "Task updated", body = Task),
        (status = 404, description = "Task not found")
    )
)]
async fn update_task(
    State(state): State<AppState>,
    Path(id): Path<i32>,
    Json(task): Json<CreateTask>,
) -> Result<Json<Task>, String> {

    let task = sqlx::query_as::<_, Task>(
        "UPDATE tasks SET title = $1 WHERE id = $2 RETURNING id, title",
    )
    .bind(task.title)
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "Task not found".to_string())?;


    // Invalidate Redis cache
    let mut redis_connection = state
        .redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| e.to_string())?;

    redis::cmd("DEL")
        .arg("tasks")
        .query_async::<()>(&mut redis_connection)
        .await
        .map_err(|e| e.to_string())?;


    Ok(Json(task))
}


// ======================================================
// DELETE TASK
// ======================================================

#[utoipa::path(
    delete,
    path = "/tasks/{id}",
    params(
        ("id" = i32, Path, description = "Task ID")
    ),
    responses(
        (status = 200, description = "Task deleted"),
        (status = 404, description = "Task not found")
    )
)]
async fn delete_task(
    State(state): State<AppState>,
    Path(id): Path<i32>,
) -> Result<String, String> {

    let result = sqlx::query(
        "DELETE FROM tasks WHERE id = $1",
    )
    .bind(id)
    .execute(&state.pool)
    .await
    .map_err(|e| e.to_string())?;


    if result.rows_affected() == 0 {
        return Err("Task not found".to_string());
    }


    // Invalidate Redis cache
    let mut redis_connection = state
        .redis
        .get_multiplexed_async_connection()
        .await
        .map_err(|e| e.to_string())?;

    redis::cmd("DEL")
        .arg("tasks")
        .query_async::<()>(&mut redis_connection)
        .await
        .map_err(|e| e.to_string())?;


    Ok("Task deleted".to_string())
}
async fn index_task(
    client: &opensearch::OpenSearch,
    task: &Task,
) -> Result<(), String> {
    client
        .index(opensearch::IndexParts::IndexId(
            "tasks",
            &task.id.to_string(),
        ))
        .body(serde_json::json!({
            "id": task.id,
            "title": task.title
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

// ======================================================
// KAFKA PRODUCER
// ======================================================

async fn publish_task_event(message: String) -> Result<(), String> {

    let producer = Producer::builder()
        .bootstrap_servers(std::env::var("KAFKA_BROKER").unwrap_or_else(|_| "127.0.0.1:9092".to_string()))
        .build()
        .await
        .map_err(|e| e.to_string())?;

    let _ = producer
        .send(
            "task-events",
            None,
            Some(message.as_bytes())
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}


// ======================================================
// KAFKA CONSUMER / WORKER
// ======================================================

async fn start_kafka_consumer() -> Result<(), String> {

    let consumer = Consumer::builder()
        .bootstrap_servers(std::env::var("KAFKA_BROKER").unwrap_or_else(|_| "127.0.0.1:9092".to_string()))
        .group_id("task-worker")
        .auto_offset_reset(AutoOffsetReset::Earliest)
        .build()
        .await
        .map_err(|e| e.to_string())?;

    consumer
        .subscribe(&["task-events"])
        .await
        .map_err(|e| e.to_string())?;

    loop {

        let records = consumer
            .poll(Duration::from_secs(1))
            .await
            .map_err(|e| e.to_string())?;

        for record in records {

            if let Some(value) = record.value {

                println!(
                    "Worker received: {}",
                    String::from_utf8_lossy(&value)
                );
            }
        }
    }
}


// ======================================================
// MAIN
// ======================================================

#[tokio::main]
async fn main() {

    dotenv()
        .expect("Failed to load .env file");


    // --------------------------------------------------
    // PostgreSQL
    // --------------------------------------------------

    let database_url = env::var("DATABASE_URL")
        .expect("DATABASE_URL must be set");

    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await
        .expect("Failed to connect to PostgreSQL");

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("Failed to run migrations");

    println!("Connected to PostgreSQL!");


    // --------------------------------------------------
    // Redis
    // --------------------------------------------------

    let redis_client = redis::Client::open(
        std::env::var("REDIS_URL").unwrap()
    )
    .unwrap();

    let _redis_connection = redis_client
        .get_multiplexed_async_connection()
        .await
        .unwrap();

    println!("Connected to Redis!");


    // --------------------------------------------------
    // OpenSearch
    // --------------------------------------------------

    let transport =
        Transport::single_node("http://localhost:9200")
            .expect("Failed to create OpenSearch transport");

    let opensearch_client =
        OpenSearch::new(transport);

    println!("Connected to OpenSearch!");


    // --------------------------------------------------
    // Kafka worker
    // --------------------------------------------------

    tokio::spawn(async {

        if let Err(error) =
            start_kafka_consumer().await
        {
            println!(
                "Kafka consumer stopped: {}",
                error
            );
        }

    });


    // --------------------------------------------------
    // Application state
    // --------------------------------------------------

    let state = AppState {
        pool: pool.clone(),
        redis: redis_client.clone(),
        opensearch: opensearch_client.clone(),
    };


    // --------------------------------------------------
    // Protected routes
    // --------------------------------------------------

    let protected_routes = Router::new()

        .route(
            "/tasks",
            post(create_task)
                .get(get_tasks),
        )

        .route(
            "/tasks/{id}",
            put(update_task)
                .delete(delete_task),
        )

        .layer(
            middleware::from_fn(auth_middleware)
        );


    // --------------------------------------------------
    // CORS
    // --------------------------------------------------

    let cors =
        CorsLayer::very_permissive();


    // --------------------------------------------------
    // Application
    // --------------------------------------------------

    let app = Router::new()

        .route(
            "/",
            get(|| async {
                "Enterprise Task Manager API"
            }),
        )

        .route(
            "/health",
            get(|| async {
                "OK"
            }),
        )

        .merge(protected_routes)

        .merge(
            SwaggerUi::new("/swagger-ui")
                .url(
                    "/api-docs/openapi.json",
                    ApiDoc::openapi(),
                ),
        )

        .layer(cors)

        .with_state(state);


    // --------------------------------------------------
    // Start server
    // --------------------------------------------------

    let listener =
        TcpListener::bind("0.0.0.0:3000")
            .await
            .unwrap();

    println!(
        "Server running on http://127.0.0.1:3000"
    );
    tokio::spawn(worker::start_worker());

    axum::serve(listener, app)
        .await
        .unwrap();
}


// ======================================================
// TESTS
// ======================================================

#[cfg(test)]
mod tests {

    use super::*;

    #[test]
    fn task_can_be_created() {

        let task = Task {
            id: 1,
            title: "Test task".to_string(),
        };

        assert_eq!(task.id, 1);
        assert_eq!(
            task.title,
            "Test task"
        );
    }
}
