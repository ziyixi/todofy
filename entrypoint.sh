#!/bin/sh

/todofy \
    -port=${PORT} \
    -allowed-users=${ALLOWED_USERS} \
    -database-path=${DATABASE_PATH} \
    -llm-addr=${LLMAddr} \
    -todo-addr=${TodoAddr} \
    -dependency-addr=${DependencyAddr} \
    -todoist-addr=${TodoistAddr} \
    -database-addr=${DatabaseAddr}
