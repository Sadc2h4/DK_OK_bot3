FROM node as build
WORKDIR /app

COPY tsconfig.json package.json package-lock.json ./
RUN npm ci
COPY src src
RUN npx tsc

FROM node as deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM gcr.io/distroless/nodejs22-debian12
USER nobody
WORKDIR /app
LABEL fly_launch_runtime="nodejs"

COPY --from=deps --chown=nobody:nogroup /app/node_modules node_modules/
COPY --from=build --chown=nobody:nogroup /app/build build/
CMD [ "build/main.js" ]
