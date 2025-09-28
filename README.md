# Todofy - Self-Hosted Task Management Tool

[![Build Status](https://github.com/ziyixi/todofy/actions/workflows/todofy-build.yml/badge.svg)](https://github.com/ziyixi/todofy/actions/workflows/todofy-build.yml)
[![codecov](https://codecov.io/gh/ziyixi/todofy/graph/badge.svg?token=2Y6YIYUYZP)](https://codecov.io/gh/ziyixi/todofy)

Todofy is a self-hosted task management tool designed to help you organize and prioritize your tasks efficiently. It's built as a collection of services, each handling a specific aspect of the application.

## 🏗️ Architecture

```mermaid
graph TB
    %% External systems and users
    User[👤 User<br/>HTTP Client]
    Email[📧 Email System<br/>Cloudmailin Webhook]
    
    %% External services
    Gemini[🤖 Google Gemini<br/>LLM API]
    Mailjet[📬 Mailjet<br/>Email Service]
    Notion[📝 Notion<br/>Database API]
    Todoist[✅ Todoist<br/>Task Management API]
    
    %% Main HTTP Server
    Main[🌐 Todofy Main Server<br/>HTTP REST API<br/>Port: 8080<br/>Basic Auth + Rate Limiting]
    
    %% Microservices
    LLM[🧠 LLM Service<br/>gRPC Server<br/>Port: 50051]
    Todo[📋 Todo Service<br/>gRPC Server<br/>Port: 50052]
    DB[🗄️ Database Service<br/>gRPC Server<br/>Port: 50053<br/>SQLite Backend]
    
    %% API endpoints
    Summary[📊 /api/summary<br/>GET endpoint]
    UpdateTodo[📝 /api/v1/update_todo<br/>POST endpoint]
    
    %% Data flow connections
    User -->|HTTPS GET| Summary
    Email -->|Webhook POST| UpdateTodo
    
    Summary --> Main
    UpdateTodo --> Main
    
    Main -->|gRPC Health Check| LLM
    Main -->|gRPC Health Check| Todo  
    Main -->|gRPC Health Check| DB
    
    Main -->|LLMSummaryRequest| LLM
    Main -->|TodoRequest| Todo
    Main -->|DatabaseQuery/Insert| DB
    
    LLM -->|API Calls| Gemini
    Todo -->|Email Send| Mailjet
    Todo -->|Task Creation| Notion
    Todo -->|Task Creation| Todoist
    
    %% Service descriptions
    Main -.->|Container| MainContainer[🐳 ghcr.io/ziyixi/todofy:latest]
    LLM -.->|Container| LLMContainer[🐳 ghcr.io/ziyixi/todofy-llm:latest]
    Todo -.->|Container| TodoContainer[🐳 ghcr.io/ziyixi/todofy-todo:latest] 
    DB -.->|Container| DBContainer[🐳 ghcr.io/ziyixi/todofy-database:latest]
    
    %% Styling
    classDef external fill:#e1f5fe,stroke:#0277bd,stroke-width:2px
    classDef service fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px
    classDef endpoint fill:#e8f5e8,stroke:#388e3c,stroke-width:2px
    classDef container fill:#fff3e0,stroke:#f57c00,stroke-width:2px,stroke-dasharray: 5 5
    
    class User,Email,Gemini,Mailjet,Notion,Todoist external
    class Main,LLM,Todo,DB service
    class Summary,UpdateTodo endpoint
    class MainContainer,LLMContainer,TodoContainer,DBContainer container
```

## ✨ Features

* **Task Management:** Core functionality for creating, updating, and managing tasks.
* **LLM Integration:** Leverages Large Language Models for enhanced task processing or insights (via `todofy-llm` service).
* **Email/API Task Population:** Allows tasks to be populated or managed via email or API interactions (via `todofy-todo` service).
* **Persistent Storage:** Uses SQLite for storing task data (via `todofy-database` service).
* **Containerized Services:** All components are containerized using Docker for easy deployment and scaling.

## 🛠️ Services

The application is composed of the following services:

1.  **Todofy (Main App)**
    * Description: The primary user-facing application or orchestrator.
    * Dockerfile: `./Dockerfile`
    * Default Port: `8080` (configurable via `PORT` env var)
    * Image: `ghcr.io/ziyixi/todofy:latest`

2.  **LLM Service (`todofy-llm`)**
    * Description: Handles tasks related to Large Language Models.
    * Dockerfile: `llm/Dockerfile`
    * Default Port: `50051` (configurable via `PORT` env var)
    * Image: `ghcr.io/ziyixi/todofy-llm:latest`

3.  **Todo Service (`todofy-todo`)**
    * Description: Manages task population, potentially via email or other APIs.
    * Dockerfile: `todo/Dockerfile`
    * Default Port: `50052` (configurable via `PORT` env var)
    * Image: `ghcr.io/ziyixi/todofy-todo:latest`

4.  **Database Service (`todofy-database`)**
    * Description: Provides database access and management using SQLite.
    * Dockerfile: `database/Dockerfile`
    * Default Port: `50053` (configurable via `PORT` env var)
    * Image: `ghcr.io/ziyixi/todofy-database:latest`

## 📦 GitHub Packages (GHCR)

Docker images for each service are automatically built and pushed to GitHub Container Registry (GHCR) by the GitHub Actions workflow. You can pull them using:

* docker pull ghcr.io/ziyixi/todofy:latest
* docker pull ghcr.io/ziyixi/todofy-llm:latest
* docker pull ghcr.io/ziyixi/todofy-todo:latest
* docker pull ghcr.io/ziyixi/todofy-database:latest
