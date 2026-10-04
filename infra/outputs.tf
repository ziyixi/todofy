# Identifiers the apps' wrangler.toml files repeat, read from the managed objects. Not secret: every value is also
# committed in a wrangler.toml. infra_state.py compares them with those files on every plan (README.md "Outputs"),
# so an AUD that changed in Cloudflare, or a wrangler.toml that names another database, fails "Infra drift" and
# "Infra apply". Keys are Worker names (access_aud also has the two applications no Worker checks itself).

output "access_aud" {
  description = "Access application AUD per app: each Worker's vars.ACCESS_AUDIENCE must equal access_aud[<its name>]."
  value = merge(
    { for key, app in cloudflare_zero_trust_access_application.owner : key => app.aud },
    { for key, app in cloudflare_zero_trust_access_application.flowday : key => app.aud },
    { for app in cloudflare_zero_trust_access_application.mail_hero_backup : "mail-hero-backup" => app.aud },
  )
}

output "d1_database_ids" {
  description = "D1 database id per database name: each [[d1_databases]] database_id must equal d1_database_ids[database_name]."
  value       = { for name, database in cloudflare_d1_database.app : name => database.id }
}

output "r2_bucket_names" {
  description = "The R2 buckets the apps bind: each [[r2_buckets]] bucket_name must be one of them."
  value       = sort([for bucket in cloudflare_r2_bucket.app : bucket.name])
}
