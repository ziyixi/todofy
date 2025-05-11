#!/bin/sh

/todo \
    -port=${PORT} \
    -mailjet-api-key-public=${MAILJET_API_KEY_PUBLIC} \
    -mailjet-api-key-private=${MAILJET_API_KEY_PRIVATE} \
    -target-email=${TARGET_EMAIL}