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
  Submit an image to Gemini Batch API for variant generation.
  - **Request Body:** `multipart/form-data` containing an `image` file (JPEG/PNG/WEBP, max 10MB). Optional `count` parameter to override default variant count.
  - **Response:** Returns the `batchName` to poll for results. Local batch metadata is stored in `jobs/`.

- **`GET /results/:batchName`**
  Poll Gemini for a batch status and generate variants once the batch succeeds.
