FROM node:18-alpine

WORKDIR /app

# Copy only what’s needed for installing dependencies and compiling
COPY package.json tsconfig.json ./
COPY .env .env
COPY ./src ./src

# Install dependencies
RUN npm install

# Compile TypeScript to JS
RUN npm run build

# Default command
CMD ["npm", "run", "docker"]
