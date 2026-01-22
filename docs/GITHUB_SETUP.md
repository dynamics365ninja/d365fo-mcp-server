# GitHub Setup Guide

This guide will help you publish your D365 F&O MCP Server to GitHub.

## Prerequisites

- Git installed and configured
- GitHub account
- GitHub CLI (optional but recommended): https://cli.github.com/

## Step 1: Update README Badges

Before pushing, update the badge URLs in [../README.md](../README.md) by replacing `YOUR_ORG` with your actual GitHub username or organization name:

```markdown
[![Build Status](https://github.com/YOUR_ORG/d365fo-mcp-server/workflows/CI/badge.svg)](https://github.com/YOUR_ORG/d365fo-mcp-server/actions)
```

## Step 2: Create GitHub Repository

### Option A: Using GitHub CLI (Recommended)

```bash
# Login to GitHub
gh auth login

# Create repository (choose public or private)
gh repo create d365fo-mcp-server --public --source=. --remote=origin --push

# Or for a private repository
gh repo create d365fo-mcp-server --private --source=. --remote=origin --push
```

### Option B: Using GitHub Web UI

1. Go to https://github.com/new
2. Repository name: `d365fo-mcp-server`
3. Description: `Model Context Protocol (MCP) server for X++ code completion in D365 Finance & Operations`
4. Choose Public or Private
5. **Do NOT** initialize with README, .gitignore, or license (already exists)
6. Click "Create repository"

Then push your code:

```bash
# Add remote
git remote add origin https://github.com/YOUR_USERNAME/d365fo-mcp-server.git

# Push code
git push -u origin main
```

## Step 3: Configure Repository Settings

### A. Repository Topics

Add these topics to help others discover your project:

```
dynamics-365, d365fo, x++, mcp, model-context-protocol, 
code-completion, github-copilot, typescript, azure, erp
```

Go to: Repository → About (gear icon) → Topics

### B. Repository Description

```
🚀 Model Context Protocol (MCP) server for X++ code completion in Microsoft Dynamics 365 Finance & Operations. Integrates with GitHub Copilot and AI assistants.
```

### C. Branch Protection (Recommended)

For `main` branch:
1. Go to Settings → Branches → Add branch protection rule
2. Branch name pattern: `main`
3. Enable:
   - ✅ Require pull request before merging
   - ✅ Require status checks to pass (select CI workflow)
   - ✅ Require branches to be up to date

## Step 4: Configure GitHub Secrets (for Azure Deployment)

If you plan to deploy to Azure, add these secrets:

Go to: Settings → Secrets and variables → Actions → New repository secret

### Required Secrets:

1. **AZURE_CREDENTIALS**
   ```bash
   az ad sp create-for-rbac \
     --name "d365fo-mcp-server" \
     --role contributor \
     --scopes /subscriptions/{subscription-id}/resourceGroups/{resource-group} \
     --sdk-auth
   ```
   Copy the entire JSON output as the secret value.

2. **AZURE_CREDENTIALS_STAGING** (if using staging environment)
   Same as above but for staging subscription/resource group.

### Optional Secrets:

- `AZURE_STORAGE_CONNECTION_STRING` - For metadata storage
- `REDIS_URL` - If using managed Redis cache

## Step 5: Test GitHub Actions

### Automatic Triggers:

- **CI Workflow**: Runs on every push/PR to `main` or `develop`
- **Deploy Workflow**: Runs on push to `main` or manual trigger
- **Release Workflow**: Runs when you create a version tag

### Manual Test:

1. Go to Actions tab
2. Select "CI" workflow
3. Click "Run workflow"
4. Choose branch: `main`
5. Click "Run workflow"

## Step 6: Create Your First Release

```bash
# Create and push a tag
git tag -a v1.0.0 -m "Initial release"
git push origin v1.0.0
```

This will:
- Trigger the Release workflow
- Create a GitHub Release with changelog
- Build and attach release artifacts (.tar.gz and .zip)

## Step 7: Enable Dependabot (Optional)

Dependabot is already configured in `.github/dependabot.yml`.

To enable:
1. Go to Settings → Code security and analysis
2. Enable "Dependabot alerts"
3. Enable "Dependabot security updates"
4. Enable "Dependabot version updates"

## Step 8: Set Up GitHub Pages (Optional)

If you want to host documentation:

1. Create a `docs/` folder
2. Add documentation files
3. Go to Settings → Pages
4. Source: Deploy from branch
5. Branch: `main`, Folder: `/docs`

## Workflows Overview

### CI Workflow (`.github/workflows/ci.yml`)
- Runs on: Push/PR to `main` or `develop`
- Tests: Linting, building, security audit
- Matrix: Node 20.x and 22.x

### Deploy Workflow (`.github/workflows/deploy.yml`)
- Runs on: Push to `main` or manual trigger
- Environments: Production and Staging
- Requires: `AZURE_CREDENTIALS` secret

### Release Workflow (`.github/workflows/release.yml`)
- Runs on: Version tags (v*)
- Creates: GitHub Release with artifacts
- Automatic: Changelog generation

## Troubleshooting

### "remote: Repository not found"
- Check repository name matches
- Verify you have access to the repository
- Check remote URL: `git remote -v`

### GitHub Actions Failing
- Check secrets are configured correctly
- Verify Azure credentials have proper permissions
- Check workflow logs in Actions tab

### Badge Not Showing
- Wait a few minutes after first workflow run
- Verify repository is public (for public badges)
- Check badge URL matches your repository

## Next Steps

- [ ] Update README badges with your GitHub username/org
- [ ] Create GitHub repository
- [ ] Configure Azure deployment secrets
- [ ] Test CI workflow
- [ ] Enable branch protection
- [ ] Create first release (v1.0.0)
- [ ] Add repository topics and description
- [ ] Enable Dependabot
- [ ] Share with the community!

## Resources

- [GitHub Actions Documentation](https://docs.github.com/actions)
- [Azure App Service Deploy Action](https://github.com/Azure/webapps-deploy)
- [Dependabot Documentation](https://docs.github.com/code-security/dependabot)
- [MCP Documentation](https://modelcontextprotocol.io/)
