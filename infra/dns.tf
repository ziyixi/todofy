# Worker Custom Domains and Email Routing retain ownership of their DNS records.
# The dedicated platform runtime CNAME is declared in platform.tf and restricted by
# infra_guard.py to that exact resource. Existing SSH, mailbox and unrelated records
# are outside this monorepo's infrastructure scope (infra/README.md "DNS").
