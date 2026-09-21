FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm i -D typescript@^5.7.2 @types/node@^24 @types/express@^5 && npx tsc -p . && npm prune --omit=dev
EXPOSE 8080
CMD ["node", "dist/index.js"]
