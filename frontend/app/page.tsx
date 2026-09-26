"use client";

import { useEffect, useState } from "react";
import keycloak from "./keycloak";

type Task = {
  id: number;
  title: string;
};

export default function Home() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");

  async function loadTasks() {
    try {
      const response = await fetch("http://127.0.0.1:3000/tasks", {
        headers: {
          Authorization: `Bearer ${keycloak.token}`,
        },
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const data = await response.json();
      setTasks(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    }
  }

  async function addTask() {
    if (!title.trim()) return;

    try {
      const response = await fetch("http://127.0.0.1:3000/tasks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${keycloak.token}`,
        },
        body: JSON.stringify({ title }),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      setTitle("");
      await loadTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add task");
    }
  }

  async function updateTask(id: number, currentTitle: string) {
    const newTitle = window.prompt("Enter new task title:", currentTitle);

    if (!newTitle?.trim()) return;

    try {
      const response = await fetch(`http://127.0.0.1:3000/tasks/${id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${keycloak.token}`,
        },
        body: JSON.stringify({ title: newTitle }),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      await loadTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update task");
    }
  }

  async function deleteTask(id: number) {
    try {
      const response = await fetch(`http://127.0.0.1:3000/tasks/${id}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${keycloak.token}`,
        },
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      await loadTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete task");
    }
  }

  useEffect(() => {
    if (keycloak.authenticated && keycloak.token) {
      loadTasks();
    }
  }, []);

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: "#f4f6f8",
        padding: "40px",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "700px",
          backgroundColor: "white",
          padding: "40px",
          borderRadius: "16px",
          boxShadow: "0 8px 30px rgba(0,0,0,0.1)",
        }}
      >
        <h1
          style={{
            textAlign: "center",
            fontSize: "32px",
            marginBottom: "10px",
          }}
        >
          Enterprise Task Manager
        </h1>

        <p
          style={{
            textAlign: "center",
            color: "#666",
            marginBottom: "35px",
          }}
        >
          Manage your tasks
        </p>

        <h2 style={{ marginBottom: "15px" }}>Tasks</h2>

        {error && (
          <p style={{ color: "red", marginBottom: "15px" }}>
            {error}
          </p>
        )}

        <div
          style={{
            display: "flex",
            gap: "12px",
            marginBottom: "30px",
          }}
        >
          <input
            type="text"
            placeholder="Enter a task..."
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                addTask();
              }
            }}
            style={{
              flex: 1,
              padding: "12px 15px",
              fontSize: "16px",
              border: "1px solid #ccc",
              borderRadius: "8px",
            }}
          />

          <button
            onClick={addTask}
            style={{
              padding: "12px 22px",
              fontSize: "16px",
              border: "none",
              borderRadius: "8px",
              backgroundColor: "#2563eb",
              color: "white",
              cursor: "pointer",
            }}
          >
            Add Task
          </button>
        </div>

        <div>
          {tasks.map((task) => (
            <div
              key={task.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "20px",
                padding: "16px 18px",
                marginBottom: "12px",
                border: "1px solid #e2e2e2",
                borderRadius: "10px",
                backgroundColor: "#fafafa",
              }}
            >
              <span
                style={{
                  flex: 1,
                  fontSize: "17px",
                  wordBreak: "break-word",
                }}
              >
                {task.title}
              </span>

              <div
                style={{
                  display: "flex",
                  gap: "10px",
                }}
              >
                <button
                  onClick={() => updateTask(task.id, task.title)}
                  style={{
                    padding: "8px 15px",
                    border: "none",
                    borderRadius: "6px",
                    backgroundColor: "#f59e0b",
                    color: "white",
                    cursor: "pointer",
                  }}
                >
                  Edit
                </button>

                <button
                  onClick={() => deleteTask(task.id)}
                  style={{
                    padding: "8px 15px",
                    border: "none",
                    borderRadius: "6px",
                    backgroundColor: "#dc2626",
                    color: "white",
                    cursor: "pointer",
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}