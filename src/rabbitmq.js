const amqp = require("amqplib");

const RABBITMQ_URL = process.env.RABBITMQ_URL || "amqp://localhost";
const RABBITMQ_QUEUE = process.env.RABBITMQ_QUEUE || "pd_sku_jobs";
const RABBITMQ_PREFETCH = parseInt(process.env.RABBITMQ_PREFETCH || "1", 10);

let connection = null;
let channel = null;
let connecting = null;

function formatRabbitError(err) {
  if (!err) return "Unknown RabbitMQ error";

  const parts = [
    err.message,
    err.code,
    err.errno ? `errno ${err.errno}` : null,
    err.syscall,
    err.address,
    err.port ? `port ${err.port}` : null,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(" | ") : String(err);
}

async function getChannel() {
  if (channel) return channel;
  if (connecting) return connecting;

  connecting = amqp.connect(RABBITMQ_URL).then(async (conn) => {
    connection = conn;
    connection.on("close", () => {
      connection = null;
      channel = null;
      connecting = null;
    });
    connection.on("error", (err) => {
      console.error("Queue Connection error:", formatRabbitError(err));
    });

    const ch = await connection.createChannel();
    await ch.assertQueue(RABBITMQ_QUEUE, { durable: true });
    await ch.prefetch(RABBITMQ_PREFETCH);
    channel = ch;
    return channel;
  });

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

async function publishJob(payload) {
  const ch = await getChannel();
  return ch.sendToQueue(RABBITMQ_QUEUE, Buffer.from(JSON.stringify(payload)), {
    contentType: "application/json",
    persistent: true,
  });
}

async function consumeJobs(handler) {
  const ch = await getChannel();
  await ch.consume(
    RABBITMQ_QUEUE,
    async (msg) => {
      if (!msg) return;

      try {
        const payload = JSON.parse(msg.content.toString("utf8"));
        await handler(payload);
        ch.ack(msg);
      } catch (err) {
        console.error("Queue Job failed:", formatRabbitError(err));
        ch.nack(msg, false, false);
      }
    },
    { noAck: false },
  );
}

async function closeRabbitMq() {
  if (channel) await channel.close();
  if (connection) await connection.close();
}

module.exports = {
  publishJob,
  consumeJobs,
  closeRabbitMq,
  RABBITMQ_QUEUE,
  RABBITMQ_URL,
  formatRabbitError,
};
