use std::time::Duration;

pub async fn start_worker() {
    println!("Background worker started!");

    loop {
        println!("Worker is running...");

        tokio::time::sleep(Duration::from_secs(10)).await;
    }
}