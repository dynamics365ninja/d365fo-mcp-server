# Azure Managed Redis Setup Guide (Standard/Premium Tiers)

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
- **Cache type** (Pricing tier):
  - **Basic B0** (250MB) - ~$15/month - **Dev only** - No SLA, single node
  - **Basic B1** (1GB) - ~$55/month - **Dev only** - No SLA, single node
  - **Basic B2** (3GB) - ~$110/month - Dev/small test - No SLA, single node
  - **Basic B3** (6GB) - ~$220/month - Larger dev - No SLA, single node
  - **Standard C0** (250MB) - ~$15/month - Dev with SLA
  - **Standard C1** (1GB) - ~$50/month - Dev/test with SLA
  - **Standard C2** (2.5GB) - ~$75/month - **Good for dev/test** - SLA, replica
  - **Standard C3** (6GB) - ~$190/month - Larger dev/test datasets
  - **Premium P1** (6GB) - ~$280/month - **Recommended for production**
- **Clustering**: Not needed for most use cases (Premium only)
- **Redis version**: 6 (latest stable)
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
CACHE_TTL=3600
```

**For Azure App Service:**
1. Go to App Service → **Configuration** → **Application settings**
2. Add/Update:
   - Name: `REDIS_URL`, Value: `rediss://:<access-key>@d365fo-mcp-cache.redis.cache.windows.net:6380`
   - Name: `REDIS_ENABLED`, Value: `true`
   - Name: `CACHE_TTL`, Value: `3600`
3. Click **Save**
4. Restart App Service

**For Azure Pipelines:**
1. Go to Azure DevOps → Pipelines → Library → Variable groups
2. Add/Update in `xpp-mcp-server-config`:
   - `REDIS_URL`: `rediss://:<access-key>@...`
   - `REDIS_ENABLED`: `true`

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

**Development (Cheapest):**
- **Basic B0** (250MB) - ~$15/month - **Cheapest option** - Good for initial testing
- **Basic B1** (1GB) - ~$55/month - Better cache size for dev
- **Standard C0** (250MB) - ~$15/month - Cheapest with SLA and replica

**Development (Recommended):**
- **Standard C2** (2.5GB) - ~$75/month - **Best value for dev** - With SLA and replica
- **Basic B2** (3GB) - ~$110/month - More cache, but no SLA (single node)

**Staging/Pre-Production:**
- **Standard C2** (2.5GB) - ~$75/month - Good for staging with SLA
- **Standard C3** (6GB) - ~$190/month - Larger datasets, closer to production

**Production:**
- **Premium P1** (6GB) - ~$280/month - **Recommended** - VNet support, clustering optional
- **Standard C3** (6GB) - ~$190/month - If Private Link is sufficient (no VNet injection)
- **Premium P2** (13GB) - ~$560/month - For larger workloads

**Cost savings vs Enterprise:**
- Standard C2 (~$75/month) vs Enterprise E10 (~$700/month) = **89% savings** ✅
- Basic B2 (~$110/month) vs Enterprise E10 (~$700/month) = **84% savings**
- Premium P1 (~$280/month) vs Enterprise E10 (~$700/month) = **60% savings**

**Recommendation for dev:** Start with **Standard C2 (2.5GB, ~$75/month)** - best value with SLA and high availability. Use Basic B2 if you need more cache space and don't require SLA.

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

| Tier | Size | Price/Month | SLA | High Availability | Private Link | VNet Injection | Best For |
|------|------|-------------|-----|-------------------|--------------|----------------|----------|
| **Basic B0** | 250MB | ~$15 | ❌ No | ❌ Single node | ❌ | ❌ | Initial testing |
| **Basic B1** | 1GB | ~$55 | ❌ No | ❌ Single node | ❌ | ❌ | Small dev cache |
| **Basic B2** | 3GB | ~$110 | ❌ No | ❌ Single node | ❌ | ❌ | Dev (more cache) |
| **Basic B3** | 6GB | ~$220 | ❌ No | ❌ Single node | ❌ | ❌ | Larger dev cache |
| **Standard C0** | 250MB | ~$15 | ✅ Yes | ✅ Replica | ✅ Yes | ❌ | Small dev with SLA |
| **Standard C2** | 2.5GB | ~$75 | ✅ Yes | ✅ Replica | ✅ Yes | ❌ | **Dev/Test (recommended)** |
| **Standard C3** | 6GB | ~$190 | ✅ Yes | ✅ Replica | ✅ Yes | ❌ | Staging |
| **Premium P1** | 6GB | ~$280 | ✅ Yes | ✅ Replica | ✅ Yes | ✅ Yes | **Production** |

**Key differences:**
- **Basic (B series)** - No SLA, single node (data loss risk), no Private Link
- **Standard (C series)** - SLA, replica (high availability), Private Link support
- **Premium (P series)** - Everything in Standard + VNet injection, clustering, persistence

**For development:** Use **Standard C2 (2.5GB, ~$75/month)** - best value with SLA and high availability. Use **Basic B2 (3GB, ~$110/month)** only if you need more cache space and can tolerate downtime.

**For staging/production:** Use **Standard C2** or higher for SLA and reliability.

## Comparison: Premium vs Standard with Private Link

| Feature | Standard + Private Link | Premium + VNet |
|---------|------------------------|----------------|
| **Price (6GB)** | ~$190/month | ~$280/month |
| **Networking** | Private Link | VNet Injection or Private Link |
| **Performance** | Good | Better |
| **Clustering** | No | Yes (optional) |
| **Persistence** | No | Yes (RDB/AOF) |
| **Geo-replication** | No | Yes |
| **Import/Export** | Limited | Full |
| **Best for** | Cost-sensitive, simple caching | Production, high availability |

**Recommendation:** Start with **Premium P1** for production (better features, flexibility). Use **Standard C3** for dev/test to save costs.
