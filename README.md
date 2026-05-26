# PD SKU API

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure Environment Variables:**
   Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

3. **Start RabbitMQ:**
   ```bash
   docker run -d --name rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:3-management
   ```

## Running the Application

**Development Mode:**
```bash
npm run dev
```

**Production Mode:**
```bash
npm start
```

By default, the server will be available at `http://localhost:3000`.

## API Endpoints

- **`GET /health`**
  Check the API health status and configuration details.

- **`POST /generate`**
  Submit an image to queue for variant generation.
  - **Request Body:** `multipart/form-data` containing an `image` file (JPEG/PNG/WEBP, max 10MB). Optional `count` parameter to override default variant count.
  - **Response:** Returns the `batchName` to poll for results.

- **`GET /results/:batchName`**
  Retrieve the status and generated variants for a specific batch.
