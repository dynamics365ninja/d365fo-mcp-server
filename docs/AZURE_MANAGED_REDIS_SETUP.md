# Azure Managed Redis Setup Guide

## Overview

Azure Managed Redis with Private Link provides secure, managed Redis caching. This guide covers Standard and Premium tiers with VNet integration for cost-effective, production-ready caching.

## Key Benefits
- ✅ **Private Link support** - No public internet exposure
- ✅ **No IP whitelist management** - Connect securely from Azure services via VNet
- ✅ **Cost effective** - Much cheaper than Enterprise tier
- ✅ **Fully managed** - Automated patching, backups, monitoring
- ✅ **Same compatibility** - Works with existing ioredis client

## Setup Steps

### 1. Create Azure Managed Redis Instance

**Via Azure Portal:**
1. Go to Azure Portal → Create a resource
2. Search for **"Azure Managed Redis"** or **"Azure Cache for Redis"**
3. Click **Create**

**Configuration:**
- **Resource group**: `d365fo-mcp-server`
- **DNS name**: `d365fo-mcp-cache` (or your preferred name)
- **Location**: Same as your App Service (for best performance)
- **Cache type** (Pricing tier — all tiers include Private Link, up to 99.999% SLA with HA, Entra ID auth):
  - **Balanced B0** (1 GB, 2 vCores) - ~$13/month (no HA) / ~$26/month (with HA) - **Dev only**
  - **Balanced B1** (1 GB, 2 vCores) - ~$26/month (no HA) / ~$51/month (with HA) - Dev/test
  - **Balanced B3** (3 GB, 2 vCores) - ~$53/month (no HA) / ~$105/month (with HA) - Small cache
  - **Balanced B5** (6 GB, 2 vCores) - ~$126/month (no HA) / ~$251/month (with HA) - Medium cache
  - **Balanced B10** (12 GB, 4 vCores) - ~$253/month (no HA) / ~$507/month (with HA) - **Good for staging/production**
  - **Balanced B20** (24 GB, 8 vCores) - ~$505/month (no HA) / ~$1,010/month (with HA) - Larger production
  - **Memory Optimized M10** (12 GB, 2 vCores) - ~$174/month (no HA) / ~$347/month (with HA) - Memory-intensive workloads
  - **Memory Optimized M20** (24 GB, 4 vCores) - ~$346/month (no HA) / ~$692/month (with HA)
  - **Compute Optimized X3** (3 GB, 4 vCores) - ~$176/month (no HA) / ~$352/month (with HA) - High throughput
  - **Compute Optimized X5** (6 GB, 4 vCores) - ~$234/month (no HA) / ~$467/month (with HA)
  - **Flash Optimized A250** (256 GB, 8 vCores) - ~$1,253/month (no HA) / ~$2,505/month (with HA) - Large low-cost storage
- **Clustering**: Available on all tiers
- **High Availability**: Run with 2 nodes for SLA (recommended for production)
- **Redis version**: Latest Redis innovations (RediSearch, RedisJSON, RedisBloom, RedisTimeSeries included)
- **Eviction policy**: `volatile-lru` (recommended for cache)

**Networking:**
- **Connectivity method**: 
  - **Private endpoint** (Recommended) - Works with Standard/Premium
  - **Public endpoint** - For development only
- If Private endpoint:
  - **Virtual Network**: Create new or use existing
  - **Subnet**: Create new subnet (e.g., `redis-subnet`)
  - **Private DNS integration**: Yes (automatically creates DNS zone)

### 2. Configure Private Endpoint (Recommended)

**For Premium tier (VNet Injection):**
1. During creation, under **Networking** tab:
   - Select **Virtual network** deployment
   - Choose/create VNet: `d365fo-vnet`
   - Choose/create subnet: `redis-subnet` (dedicated subnet required)

**For Standard/Premium tier (Private Link):**
1. After creation, go to Redis → **Private endpoint connections**
2. Click **+ Private endpoint**
3. Configure:
   - **Resource group**: `d365fo-mcp-server`
   - **Name**: `redis-private-endpoint`
   - **Region**: Same as Redis cache
   - **Virtual network**: `d365fo-vnet`
   - **Subnet**: `redis-subnet` (can share with other Private Link resources)
   - **Private DNS integration**: Yes
4. Click **Create**

**Integrate App Service with VNet:**
1. Go to App Service → **Networking**
2. Click **VNet Integration**
3. Click **Add VNet**
4. Select VNet: `d365fo-vnet`
5. Select/create subnet for App Service: `app-service-subnet` (separate from redis-subnet)
6. Click **OK**

### 3. Get Connection String

**Via Azure Portal:**
1. Go to your Redis cache instance
2. Click **Access keys** (under Settings)
3. You'll see:
   - **Primary connection string (StackExchange.Redis)**: e.g., `d365fo-mcp-cache.redis.cache.windows.net:6380,password=xxx,ssl=True`
   - **Primary key**: The access key only
   - **Secondary key**: Backup access key

**Convert to ioredis format:**

From Azure connection string:
```
d365fo-mcp-cache.redis.cache.windows.net:6380,password=<access-key>,ssl=True
```

To ioredis format:
```
rediss://:<access-key>@d365fo-mcp-cache.redis.cache.windows.net:6380
```

Example:
```
rediss://:YOUR_ACCESS_KEY_HERE@d365fo-mcp-cache.redis.cache.windows.net:6380
```

**Note:** Port is **6380** for SSL (always use SSL in production)

### 4. Configure Environment Variables

**For local development (.env file):**
```bash
REDIS_URL=rediss://:<access-key>@d365fo-mcp-cache.redis.cache.windows.net:6380
REDIS_ENABLED=true
REDIS_CLUSTER_MODE=true   # Required for Azure Managed Redis (Enterprise/cluster tier)
CACHE_TTL=3600
```

**For Azure App Service:**
1. Go to App Service → **Configuration** → **Application settings**
2. Add/Update:
   - Name: `REDIS_URL`, Value: `rediss://:<access-key>@d365fo-mcp-cache.redis.cache.windows.net:6380`
   - Name: `REDIS_ENABLED`, Value: `true`
   - Name: `REDIS_CLUSTER_MODE`, Value: `true`  ← **required if you see `MOVED` errors in logs**
   - Name: `CACHE_TTL`, Value: `3600`
3. Click **Save**
4. Restart App Service

**For Azure Pipelines:**
1. Go to Azure DevOps → Pipelines → Library → Variable groups
2. Add/Update in `xpp-mcp-server-config`:
   - `REDIS_URL`: `rediss://:<access-key>@...`
   - `REDIS_ENABLED`: `true`
   - `REDIS_CLUSTER_MODE`: `true`

### 5. Test Connection

**Local test:**
```bash
npm run test-redis
```

**From App Service (via Kudu console):**
```bash
# SSH into App Service
curl https://<app-service-name>.scm.azurewebsites.net/api/command \
  -u <deployment-username>:<deployment-password> \
  -H "Content-Type: application/json" \
  -d '{"command":"npm run test-redis","dir":"/home/site/wwwroot"}'
```

## Migration from Azure Cache for Redis

### Option 1: Side-by-side (Recommended)

1. Create new Managed Redis instance
2. Update environment variables to point to new instance
3. Restart services
4. Monitor for issues
5. Delete old Redis cache after verification

### Option 2: Export/Import Data

If you have existing data to migrate:

```bash
# Export from old Redis
redis-cli -h <old-redis>.redis.cache.windows.net -p 6380 -a <old-key> --tls --dump > redis-backup.rdb

# Import to new Redis (via support ticket or manual migration)
```

## Networking Scenarios

### Scenario 1: Private Endpoint (Production - Recommended)
- ✅ Secure - No public internet exposure
- ✅ Fast - Private network connection
- ✅ Simple - No firewall management
- ❌ Cannot test from local machine (need VPN or Bastion)

**Use this if:**
- Production environment
- Security is priority
- App Service in same region

### Scenario 2: Public Endpoint with Firewall (Dev/Test)
- ✅ Can test from local machine
- ✅ Good for development
- ❌ Need to manage firewall IPs
- ❌ Less secure

**Use this if:**
- Development environment
- Need local testing
- Temporary setup

### Scenario 3: Public Endpoint with "Allow Azure Services"
- ✅ Azure services can connect
- ✅ No individual IP management
- ✅ Good for dev/test
- ❌ Still exposed to internet

## Troubleshooting

### Connection Timeout from App Service
- Check VNet integration is configured
- Verify Private DNS zone is linked to VNet
- Check NSG rules allow outbound to Redis subnet

### Connection Timeout from Local Machine
- If using Private Endpoint: Expected (use VPN/Bastion)
- If using Public Endpoint: Check firewall rules

### WRONGPASS Error
- Verify access key is correct
- Check authentication is enabled (not Azure AD only)

### High Latency
- Check App Service and Redis are in same region
- Consider using Private Endpoint for better performance
- Check VNet integration is properly configured

## Cost Optimization

> **Note:** All Azure Managed Redis tiers support Private Link, Microsoft Entra ID auth, and up to 99.999% SLA (when running with HA — 2 nodes). Prices below are per-node (without HA) / with HA.

**Development (Cheapest — single node, no HA):**
- **Balanced B0** (1 GB) - ~$13/month - **Cheapest option** - Good for initial testing
- **Balanced B1** (1 GB) - ~$26/month - **Recommended for dev** - Best value, full feature set
- **Balanced B3** (3 GB) - ~$53/month - More cache space for dev

**Staging/Testing (with HA — 2 nodes):**
- **Balanced B3** (3 GB) - ~$105/month - Small staging with HA
- **Balanced B5** (6 GB) - ~$251/month - **Recommended for staging** - Good balance of cost and capacity
- **Balanced B10** (12 GB) - ~$507/month - Larger staging datasets

**Production (with HA — 2 nodes):**
- **Balanced B10** (12 GB) - ~$507/month - **Recommended entry-level production** - Good performance, full features
- **Balanced B20** (24 GB) - ~$1,010/month - Larger production workloads
- **Memory Optimized M10** (12 GB) - ~$347/month - Memory-intensive workloads at lower cost
- **Memory Optimized M20** (24 GB) - ~$692/month - Large in-memory datasets
- **Compute Optimized X5** (6 GB) - ~$467/month - Maximum throughput for mission-critical services
- **Compute Optimized X10** (12 GB) - ~$936/month - High-performance production

**Recommendation for dev:** Start with **Balanced B0 (~$13/month)** or **B1 (~$26/month)** — significantly cheaper than previous tiers with full feature support. Upgrade to **B5 with HA (~$251/month)** for staging.

## Security Best Practices

1. **Use Private Endpoint** - No public internet exposure
2. **Rotate keys regularly** - Update access keys quarterly
3. **Use separate instances** - Different Redis for dev/prod
4. **Enable TLS** - Always use `rediss://` (SSL/TLS)
5. **Monitor access** - Enable diagnostic logging
6. **Set TTL** - Don't cache data indefinitely

## Monitoring

**Enable diagnostics:**
1. Redis instance → **Diagnostic settings**
2. Add diagnostic setting
3. Send to Log Analytics workspace
4. Monitor:
   - Connection count
   - Cache hit/miss ratio
   - Memory usage
   - Commands/sec

## Support

**Documentation:**
- [Azure Managed Redis](https://docs.microsoft.com/azure/azure-cache-for-redis/)
- [Private Link Configuration](https://docs.microsoft.com/azure/azure-cache-for-redis/cache-private-link)
- [VNet Injection (Premium)](https://docs.microsoft.com/azure/azure-cache-for-redis/cache-how-to-premium-vnet)

**Tools:**
- Test connection: `npm run test-redis`
- Monitor: Azure Portal → Metrics
- Query: Use redis-cli or Azure Portal Console

## Comparison: Tiers for Development

> All Azure Managed Redis tiers support Private Link, Entra ID auth, zone redundancy, data persistence, clustering, and up to 99.999% SLA (with HA). Prices shown as: **no HA / with HA**.

| Tier | Size | vCores | Price/Month (no HA / with HA) | Best For |
|------|------|--------|-------------------------------|----------|
| **Balanced B0** | 1 GB | 2 | ~$13 / ~$26 | Initial testing — cheapest option |
| **Balanced B1** | 1 GB | 2 | ~$26 / ~$51 | **Dev (best value)** |
| **Balanced B3** | 3 GB | 2 | ~$53 / ~$105 | Dev with more cache |
| **Balanced B5** | 6 GB | 2 | ~$126 / ~$251 | **Staging** |
| **Balanced B10** | 12 GB | 4 | ~$253 / ~$507 | **Entry-level production** |
| **Balanced B20** | 24 GB | 8 | ~$505 / ~$1,010 | Larger production workloads |
| **Balanced B50** | 60 GB | 16 | ~$1,010 / ~$2,019 | Large-scale production |
| **Memory Opt. M10** | 12 GB | 2 | ~$174 / ~$347 | Memory-intensive, lower CPU needs |
| **Memory Opt. M20** | 24 GB | 4 | ~$346 / ~$692 | Large in-memory datasets |
| **Compute Opt. X3** | 3 GB | 4 | ~$176 / ~$352 | High throughput, small cache |
| **Compute Opt. X5** | 6 GB | 4 | ~$234 / ~$467 | Mission-critical, max throughput |
| **Compute Opt. X10** | 12 GB | 8 | ~$468 / ~$936 | High-performance production |
| **Flash Opt. A250** *(Preview)* | 256 GB | 8 | ~$1,253 / ~$2,505 | Large cache at low cost/GB |

**Key differences between tier families:**
- **Balanced (B series)** — Best general-purpose tier; balanced CPU-to-memory ratio for most workloads
- **Memory Optimized (M series)** — High memory-to-core ratio; ideal for large datasets with lower CPU requirements
- **Compute Optimized (X series)** — High CPU-to-memory ratio; best for maximum throughput and mission-critical services
- **Flash Optimized (A series)** *(Preview)* — NVMe storage + RAM; lowest cost per GB for very large caches (no RediSearch/Bloom/TimeSeries)

**For development:** Use **Balanced B0 (~$13/month)** or **B1 (~$26/month)** — significantly cheaper than before with full feature support.

**For staging/testing:** Use **Balanced B5 with HA (~$251/month)** — good capacity with high availability.

**For production:** Use **Balanced B10 with HA (~$507/month)** as entry point; choose Memory Optimized or Compute Optimized based on your workload profile.

## Comparison: Tier Families

| Feature | Balanced (B) | Memory Optimized (M) | Compute Optimized (X) | Flash Optimized (A) |
|---------|-------------|---------------------|----------------------|--------------------|
| **Memory range** | 1 GB – 960 GB | 12 GB – 1,920 GB | 3 GB – 720 GB | 256 GB – 4,723 GB |
| **Use case** | General purpose | Large datasets, lower CPU | Max throughput | Large cache, low cost/GB |
| **Price entry (with HA)** | ~$26/month (B1) | ~$347/month (M10) | ~$352/month (X3) | ~$2,505/month (A250) |
| **Private Link** | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |
| **SLA (with HA)** | Up to 99.999% | Up to 99.999% | Up to 99.999% | Up to 99.999% |
| **Clustering** | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |
| **Persistence** | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |
| **Geo-replication** | Active-Active | Active-Active | Active-Active | ❌ No |
| **RediSearch** | ✅ Yes | ✅ Yes | ✅ Yes | ❌ No |
| **RedisJSON** | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes |
| **RedisBloom** | ✅ Yes | ✅ Yes | ✅ Yes | ❌ No |
| **Redis on Flash** | ❌ No | ❌ No | ❌ No | ✅ Yes |

**Recommendation:** Use **Balanced B1 (~$26/month with HA)** for dev, **Balanced B5 with HA (~$251/month)** for staging, and **Balanced B10 with HA (~$507/month)** or higher for production.
