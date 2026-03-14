#!/bin/sh

/todo \
    -port=${PORT} \
    -todoist-api-key=${TODOIST_API_KEY} \
    -todoist-project-id=${TODOIST_PROJECT_ID} \
    -todoist-webhook-secret=${TODOIST_WEBHOOK_SECRET} \
    -dependency-reconcile-interval=${DEPENDENCY_RECONCILE_INTERVAL} \
    -dependency-webhook-debounce=${DEPENDENCY_WEBHOOK_DEBOUNCE} \
    -dependency-grace-period=${DEPENDENCY_GRACE_PERIOD} \
    -dependency-enable-scheduler=${DEPENDENCY_ENABLE_SCHEDULER}
