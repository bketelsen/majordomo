# Token Bucket Rate Limiter

A zero-dependency, production-ready token bucket rate limiting implementation for TypeScript/Node.js.

## Features

- ✅ **Zero Dependencies** - Pure TypeScript implementation
- ✅ **Precise Time-based Refill** - Millisecond-accurate token refilling
- ✅ **Flexible Consumption** - Variable token costs for different operations
- ✅ **Multi-Bucket Support** - Manage rate limits per user, IP, domain, etc.
- ✅ **Automatic Cleanup** - Prevents memory leaks with TTL-based bucket expiration
- ✅ **Built-in Presets** - Common rate limit configurations
- ✅ **TypeScript First** - Full type safety and IntelliSense support
- ✅ **Battle-tested** - Comprehensive test suite (75+ tests)

## Quick Start

### Basic Usage

```typescript
import { TokenBucket } from "./lib/token-bucket.ts";

// Create a bucket: 10 token capacity, refill 2 tokens/second
const bucket = new TokenBucket(10, 2);

// Try to consume tokens
if (bucket.consume(1)) {
  // Request allowed
  processRequest();
} else {
  // Rate limit exceeded
  throw new Error("Too many requests");
}
```

### Multi-User Rate Limiting

```typescript
import { RateLimiter, RATE_LIMIT_PRESETS } from "./lib/rate-limiter.ts";

// Create limiter for user requests
const userLimiter = new RateLimiter({
  ...RATE_LIMIT_PRESETS.NORMAL,
  keyPrefix: "user",
});

// Check limit per user
if (userLimiter.checkLimit(userId)) {
  // Process request
} else {
  // User is rate limited
  const status = userLimiter.getStatus(userId);
  console.log(`Retry after ${status.retryAfter} seconds`);
}
```

## API Reference

### TokenBucket

Core token bucket implementation.

#### Constructor

```typescript
new TokenBucket(capacity: number, refillRate: number)
```

- `capacity` - Maximum number of tokens the bucket can hold
- `refillRate` - Number of tokens to refill per second

#### Methods

**`consume(tokens?: number): boolean`**

Attempt to consume tokens from the bucket.

- Returns `true` if tokens were consumed
- Returns `false` if insufficient tokens
- Default: consumes 1 token

**`getTokens(): number`**

Get the current number of available tokens (includes automatic refill).

**`reset(): void`**

Reset the bucket to full capacity.

**`getConfig(): TokenBucketConfig`**

Get the bucket's configuration (capacity and refillRate).

**`getTimeUntilTokens(tokens: number): number`**

Calculate seconds until the requested number of tokens will be available.

- Returns `0` if tokens are already available
- Returns `Infinity` if refillRate is zero

---

### RateLimiter

Wrapper for managing multiple token buckets.

#### Constructor

```typescript
new RateLimiter(config: RateLimiterConfig)
```

**Config Options:**

```typescript
interface RateLimiterConfig {
  capacity: number;        // Max tokens per bucket
  refillRate: number;      // Tokens per second
  keyPrefix?: string;      // Prefix for bucket keys (default: "rl")
  cleanupTTL?: number;     // Seconds before unused buckets expire (default: 3600)
}
```

#### Methods

**`checkLimit(key: string, tokens?: number): boolean`**

Check if a request is allowed for the given key.

- Creates a new bucket if key doesn't exist
- Logs warnings when rate limits are exceeded
- Default: consumes 1 token

**`getStatus(key: string): RateLimitStatus`**

Get the current status for a key.

Returns:
```typescript
interface RateLimitStatus {
  tokens: number;         // Available tokens
  capacity: number;       // Bucket capacity
  refillRate: number;     // Refill rate
  retryAfter: number;     // Seconds until tokens available
}
```

**`reset(key: string): void`**

Reset a specific key's bucket to full capacity.

**`remove(key: string): void`**

Remove a specific key's bucket.

**`getKeys(): string[]`**

Get all active bucket keys.

**`cleanup(): number`**

Manually trigger cleanup of stale buckets. Returns number of buckets removed.

**`destroy(): void`**

Stop the rate limiter and cleanup all resources.

**`size(): number`**

Get the total number of active buckets.

---

### Rate Limit Presets

Pre-configured rate limiting strategies:

```typescript
import { RATE_LIMIT_PRESETS } from "./lib/rate-limiter.ts";

// STRICT: 5 tokens, 1/sec refill (high-frequency prevention)
RATE_LIMIT_PRESETS.STRICT

// NORMAL: 10 tokens, 2/sec refill (standard API usage)
RATE_LIMIT_PRESETS.NORMAL

// BURST: 50 tokens, 5/sec refill (allow bursts with recovery)
RATE_LIMIT_PRESETS.BURST

// GENEROUS: 100 tokens, 20/sec refill (internal services)
RATE_LIMIT_PRESETS.GENEROUS
```

## Usage Examples

### Telegram Bot Rate Limiting

```typescript
const userLimiter = new RateLimiter({
  capacity: 10,
  refillRate: 2,
  keyPrefix: "telegram-user",
});

async function handleTelegramMessage(userId: number, message: string) {
  if (!userLimiter.checkLimit(userId.toString())) {
    const status = userLimiter.getStatus(userId.toString());
    return await ctx.reply(
      `⏳ Too many messages. Please wait ${Math.ceil(status.retryAfter)} seconds.`
    );
  }
  
  // Process message normally
}
```

### API Middleware (Hono)

```typescript
import { Hono } from "hono";

const app = new Hono();
const apiLimiter = new RateLimiter(RATE_LIMIT_PRESETS.BURST);

app.use("/api/*", async (c, next) => {
  const ip = c.req.header("x-forwarded-for") || c.req.ip || "unknown";
  
  if (!apiLimiter.checkLimit(ip)) {
    const status = apiLimiter.getStatus(ip);
    return c.json({
      error: "Rate limit exceeded",
      retryAfter: Math.ceil(status.retryAfter),
    }, 429);
  }
  
  await next();
});
```

### Variable Cost Operations

```typescript
const fileBucket = new TokenBucket(100, 10);

function processFile(sizeInMB: number) {
  // Larger files cost more tokens (1 token per 10MB)
  const cost = Math.ceil(sizeInMB / 10);
  
  if (!fileBucket.consume(cost)) {
    const retryAfter = fileBucket.getTimeUntilTokens(cost);
    throw new Error(`Rate limit exceeded. Retry after ${retryAfter.toFixed(1)}s`);
  }
  
  // Process file...
}
```

### Graceful Degradation

```typescript
const aiLimiter = new TokenBucket(50, 5);

function handleRequest(message: string) {
  const tokens = aiLimiter.getTokens();
  
  if (tokens >= 10) {
    // Use expensive AI processing
    aiLimiter.consume(10);
    return processWithAI(message);
  } else if (aiLimiter.consume(1)) {
    // Fall back to simple processing
    return processBasic(message);
  } else {
    // Queue for later
    return { queued: true };
  }
}
```

## Configuration via Environment Variables

Add to your `.env` file:

```bash
# Telegram rate limiting
TELEGRAM_USER_CAPACITY=10
TELEGRAM_USER_REFILL_RATE=2

# API rate limiting
API_RATE_CAPACITY=50
API_RATE_REFILL=5

# Domain operations
DOMAIN_OPS_CAPACITY=5
DOMAIN_OPS_REFILL=1
```

Usage:

```typescript
const limiter = new RateLimiter({
  capacity: parseInt(process.env.TELEGRAM_USER_CAPACITY || "10"),
  refillRate: parseInt(process.env.TELEGRAM_USER_REFILL_RATE || "2"),
});
```

## Testing

Run the test suite:

```bash
# Test TokenBucket
bun test lib/__tests__/token-bucket.test.ts

# Test RateLimiter
bun test lib/__tests__/rate-limiter.test.ts

# Run all tests
bun test lib/__tests__/
```

Test coverage includes:
- Basic consumption and refill mechanics
- Time-based scenarios
- Edge cases (zero capacity, negative values, clock skew)
- Multi-bucket management
- Cleanup and memory management
- Performance benchmarks
- Realistic usage scenarios

## How It Works

### Token Bucket Algorithm

1. **Initialization**: Bucket starts full with `capacity` tokens
2. **Refill**: Tokens are added at `refillRate` per second (continuous)
3. **Consumption**: Each request consumes tokens
4. **Limiting**: Requests are denied when insufficient tokens

**Refill Formula:**
```
tokens_to_add = (current_time - last_refill_time) × refill_rate
current_tokens = min(capacity, current_tokens + tokens_to_add)
```

### Automatic Cleanup

The RateLimiter automatically removes stale buckets:
- Runs every 5 minutes
- Removes buckets unused for `cleanupTTL` seconds (default: 1 hour)
- Prevents memory leaks in long-running applications

## Performance

Benchmarks (Bun runtime):
- **Single bucket**: 500,000+ operations/second
- **Multi-bucket (1000 keys)**: 10,000+ operations/second
- **Memory**: <100 bytes per bucket
- **Precision**: Millisecond-accurate refills

## Production Considerations

### Single Instance

For single-server deployments, the in-memory implementation is perfect:
- No external dependencies
- Sub-millisecond performance
- Automatic cleanup

### Distributed Systems

For multi-server deployments, consider:
- Using Redis-backed rate limiting (separate implementation needed)
- Session affinity / sticky sessions
- Shared state via distributed cache

### Monitoring

```typescript
// Log rate limit metrics
const status = limiter.getStatus(userId);
console.log({
  user: userId,
  tokens: status.tokens,
  capacity: status.capacity,
  utilizationPct: ((1 - status.tokens / status.capacity) * 100).toFixed(1),
});

// Track active buckets
console.log(`Active rate limit buckets: ${limiter.size()}`);
console.log(`Active users: ${limiter.getKeys().length}`);
```

## License

MIT

## See Also

- `rate-limiter-examples.ts` - Comprehensive usage examples
- `__tests__/token-bucket.test.ts` - TokenBucket test suite
- `__tests__/rate-limiter.test.ts` - RateLimiter test suite
