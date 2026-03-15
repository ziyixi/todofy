#!/bin/sh

/todo \
    -port=${PORT} \
    -todoist-api-key=${TODOIST_API_KEY} \
    -todoist-default-project-id=${TODOIST_DEFAULT_PROJECT_ID} \
    -todoist-webhook-secret=${TODOIST_WEBHOOK_SECRET} \
    -todoist-base-url=${TODOIST_BASE_URL} \
    -dependency-reconcile-interval=${DEPENDENCY_RECONCILE_INTERVAL} \
    -dependency-webhook-debounce=${DEPENDENCY_WEBHOOK_DEBOUNCE} \
    -dependency-grace-period=${DEPENDENCY_GRACE_PERIOD} \
    -dependency-reconcile-timeout=${DEPENDENCY_RECONCILE_TIMEOUT} \
    -dependency-read-timeout=${DEPENDENCY_READ_TIMEOUT} \
    -dependency-write-timeout=${DEPENDENCY_WRITE_TIMEOUT} \
    -dependency-enable-scheduler=${DEPENDENCY_ENABLE_SCHEDULER} \
    -dependency-bootstrap-excluded-project-ids=${DEPENDENCY_BOOTSTRAP_EXCLUDED_PROJECT_IDS}
