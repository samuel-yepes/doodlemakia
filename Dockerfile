# Distrito Garabato (Doodle District) - Dockerfile de sitio estático
FROM nginx:1.27-alpine

# Copiar archivos del sitio al directorio predeterminado de nginx
COPY . /usr/share/nginx/html

# Estrategia de caché de recursos estáticos: los archivos en vendor son inmutables, caché larga; el resto caché corta
RUN printf 'server {\n\
    listen 80;\n\
    server_name _;\n\
    root /usr/share/nginx/html;\n\
    index index.html;\n\
    gzip on;\n\
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;\n\
    location /vendor/ {\n\
        expires 30d;\n\
        add_header Cache-Control "public, immutable";\n\
    }\n\
    location / {\n\
        try_files $uri $uri/ /index.html;\n\
    }\n\
}\n' > /etc/nginx/conf.d/default.conf

EXPOSE 80
