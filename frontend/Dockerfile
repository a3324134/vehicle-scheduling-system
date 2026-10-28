# Dependencies and sources, shared by the test and build stages.
FROM node:22-alpine AS deps
WORKDIR /app
ENV NG_CLI_ANALYTICS=false
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .

# Unit tests of the pure logic: docker compose run --rm frontend-test
FROM deps AS test
CMD ["npm", "test"]

FROM deps AS build
RUN npm run build

# nginx serves the built app and forwards /api to the backend, so the
# browser sees one origin and there is no CORS (design doc 十五).
FROM nginx:1.30-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/frontend/browser /usr/share/nginx/html
