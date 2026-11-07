`deploy/Caddyfile`: TLS for `SITE_HOST`, gzip, `@api` matcher for `/api/*`, `/auth/*`, `/confirm*`, `/captcha*`, `/health` to `api:3000`, else `try_files {path} /index.html`.
