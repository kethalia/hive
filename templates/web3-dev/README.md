# Web3 Full-Stack Development - Coder Template

A production-ready Coder template for modern Web3 and full-stack development. Features Docker, Node.js, Foundry, and comprehensive tooling - all auto-configured and optimized for fast startup.

[![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)](https://github.com/yourusername/coder-template)
[![Coder](https://img.shields.io/badge/coder-v2.x-purple.svg)](https://coder.com)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

## 🚀 Features

### Development Environment
- ✅ **Docker** - Full Docker + Compose + act (run GitHub Actions locally)
- ✅ **Node.js** - Multiple versions (18, 20, 22, 24) with PNPM
- ✅ **Foundry** - Complete Ethereum development toolkit (forge, cast, anvil, chisel)
- ✅ **Git** - Latest version with productivity aliases
- ✅ **ZSH** - Oh My Zsh with Powerlevel10k and plugins

### VS Code Integration
- 21 curated extensions including:
  - Solidity (Hardhat + language support)
  - Docker client
  - Tailwind CSS, GraphQL, Prisma
  - GitLens, Error Lens, Prettier
  - Code spell checker & TODO highlights

### Performance & Reliability
- ⚡ **Fast startup** - 30-60 seconds after first boot (3-5 min initial)
- 🎯 **Resource limits** - Configurable memory (8GB) and CPU (4 cores)
- 🔍 **Health checks** - Automatic container health monitoring
- 📊 **Monitoring** - Built-in Docker and workspace metrics
- 🛡️ **Optimized** - 15% smaller image (~3.6GB), smart caching

## 📋 Quick Start

### Prerequisites
- Coder v2.x deployed and running
- Docker available on Coder host
- Coder CLI installed (optional but recommended)

### Installation

**Option 1: Using Coder CLI (Recommended)**

```bash
# Clone or download this repository
git clone https://github.com/yourusername/coder-template.git
cd coder-template

# Push to your Coder instance
coder templates push web3-dev-workspace
```

**Option 2: Using Coder UI**

1. Download/clone this repository
2. In Coder UI: Templates → Create Template
3. Upload the directory or connect git repository
4. Configure metadata:
   - Name: `web3-dev-workspace`
   - Display Name: `Web3 Full-Stack Development`
   - Description: `Complete dev environment: Docker, Node.js 24, Foundry, act. Auto-configured, ready in 60 seconds.`

### Create Your First Workspace

```bash
# Create workspace from template
coder create --template web3-dev-workspace my-workspace

# SSH into workspace
coder ssh my-workspace

# Verify everything works
docker ps
node --version
forge --version
```

## 🛠️ What's Included

### Core Technologies

| Tool | Version | Purpose |
|------|---------|---------|
| Docker | Latest | Container runtime + Compose |
| Node.js | 18, 20, 22, 24 | JavaScript runtime |
| PNPM | Latest | Fast package manager |
| Foundry | Latest | Ethereum development |
| Git | Latest | Version control |
| ZSH | Latest | Shell with Oh My Zsh |

### Development Tools

**Node.js Ecosystem**
- Multiple Node versions via switcher
- PNPM for fast, efficient installs
- All standard npm/node tools

**Blockchain/Web3**
- Foundry (forge, cast, anvil, chisel)
- Hardhat support via VS Code
- Solidity language support

**CI/CD**
- act - Run GitHub Actions locally
- Docker for containerized workflows

### Shell Enhancements

**Git Aliases**
```bash
gs          # git status
gco         # git checkout
gc          # git commit
gp          # git pull
git lg      # pretty log graph
```

**Shell Aliases**
```bash
d           # docker
dc          # docker-compose
g           # git
ll          # ls -lah
k           # kubectl
```

## 📊 Resource Configuration

Default settings (all configurable):

```hcl
# Memory limit
workspace_memory_gb = 8     # 8GB RAM (16GB swap)

# CPU limit
workspace_cpus = 4          # 4 CPU cores

# Optional dotfiles
dotfiles_uri = ""           # Your dotfiles repo URL
```

Adjust these in `main.tf` or via Coder UI parameters.

## 🎯 Use Cases

### Perfect For

✅ **Web3/Blockchain Development**
- Smart contract development with Solidity
- Testing with Foundry and Hardhat
- Local blockchain with Anvil

✅ **Full-Stack Web Development**
- Node.js backend services
- Docker-based microservices

✅ **DevOps & CI/CD**
- Testing GitHub Actions with act
- Docker container development
- Infrastructure as code

✅ **Multi-Language Projects**
- Node.js + Solidity
- Complex tech stacks
- Full-stack development teams

## 📁 Template Structure

```
coder-template/
├── .coder/
│   └── coder.yaml              # Template metadata
├── build/
│   └── Dockerfile              # Container image definition
├── main.tf                     # Terraform configuration (main file)
├── README.md                   # This file
├── INSTALL.md                  # Detailed installation guide
├── .gitignore                  # Git ignore rules
└── template.yaml               # Alternative metadata format
```

## ⚙️ Configuration & Customization

### Adjusting Resource Limits

Edit `main.tf`:

```hcl
variable "workspace_memory_gb" {
  description = "Memory limit for workspace in GB"
  type        = number
  default     = 16  # Increase for heavy workloads
}

variable "workspace_cpus" {
  description = "CPU limit for workspace"
  type        = number
  default     = 8   # Increase for compilation-heavy work
}
```

### Adding Dotfiles Support

Add your dotfiles repository:

```hcl
variable "dotfiles_uri" {
  description = "Git URI for dotfiles repository"
  type        = string
  default     = "https://github.com/yourusername/dotfiles"
}
```

Your dotfiles repo should include an `install.sh` script.

### Adding VS Code Extensions

Edit the `code-server` module in `main.tf`:

```hcl
extensions = [
  # ... existing extensions ...
  "publisher.extension-name",
  "another.extension",
]
```

### Modifying the Base Image

Edit `build/Dockerfile` to add packages:

```dockerfile
RUN apt-get update && apt-get install -y \
    your-package-here \
    another-package \
    && rm -rf /var/lib/apt/lists/*
```

## 🏗️ Architecture

### Container Architecture
```
┌─────────────────────────────────────┐
│   Coder Workspace Container         │
│                                     │
│  ┌──────────────────────────────┐   │
│  │  User Environment            │   │
│  │  - ZSH + Oh My Zsh           │   │
│  │  - Node.js + PNPM            │   │
│  │  - Python + Tools            │   │
│  │  - Foundry + Solidity        │   │
│  └──────────────────────────────┘   │
│                                     │
│  ┌──────────────────────────────┐   │
│  │  Services                    │   │
│  │  - VS Code Server            │   │
│  └──────────────────────────────┘   │
│                                     │
│  ┌──────────────────────────────┐   │
│  │  Docker Socket (mounted)     │   │
│  │  /var/run/docker.sock        │   │
│  └──────────────────────────────┘   │
└─────────────────────────────────────┘
           │
           ▼
    ┌──────────────┐
    │  Host Docker │
    │  Daemon      │
    └──────────────┘
```

### Startup Flow
```
Workspace Start
    │
    ├─► Initialize Coder Agent
    │
    ├─► Run Startup Script
    │   ├─► Check if first boot
    │   ├─► Setup Git aliases
    │   ├─► Clone dotfiles (if configured)
    │   └─► Generate README.md
    │
    ├─► Run Development Tools Script
    │   ├─► Install Oh My Zsh (if needed)
    │   ├─► Install PNPM (if needed)
    │   ├─► Install Foundry (if needed)
    │   └─► Install act (if needed)
    │
    └─► Workspace Ready! 🎉
```

## 📈 Performance

### Startup Times
- **First boot**: 3-5 minutes (one-time tool installation)
- **Subsequent boots**: 30-60 seconds (services only)
- **Improvement**: 40-60% faster than v1.x

### Resource Usage
- **Image size**: ~3.6GB (15% smaller than v1.x)
- **Idle workspace**: ~500MB RAM, <5% CPU
- **Active development**: 2-4GB RAM, 10-50% CPU
- **Maximum**: 8GB RAM, 4 CPUs (configurable)

### Optimization Features
- ✅ Smart tool installation (check before install)
- ✅ Docker layer caching
- ✅ Persistent home volume
- ✅ Resource limits prevent runaway processes
- ✅ Health checks for reliability

## 🔒 Security Considerations

### Docker Socket Access
⚠️ **Important**: This template mounts the Docker socket (`/var/run/docker.sock`) which provides:

**Benefits:**
- Full Docker functionality
- Native performance
- Run containers, docker-compose
- Test with act (GitHub Actions)

**Security Implications:**
- Users can access host Docker daemon
- Potential to see/interact with other containers
- Effectively root-level access to Docker

**Recommendations:**
- ✅ Use in trusted development environments
- ✅ Implement network isolation if needed
- ✅ Consider Docker authorization plugins
- ✅ Monitor Docker API usage
- ✅ Use for development, not production workloads

### Resource Limits
- Memory and CPU limits prevent DoS
- Configurable per workspace
- Helps with multi-tenant isolation

### Best Practices
- Review who has template access
- Monitor workspace resource usage
- Implement least-privilege where possible
- Keep base image updated
- Regular security audits

## 🧪 Testing

### Verify Installation

After deploying the template:

```bash
# Create test workspace
coder create --template web3-dev-workspace test-workspace

# SSH into workspace
coder ssh test-workspace

# Run verification tests
docker ps                    # Should work
docker run hello-world       # Should pull and run

node --version               # Should show Node 24.x
pnpm --version              # Should show PNPM version

forge --version             # Should show Foundry version
cast --version              # Should work

act --version               # Should show act version

cat ~/README.md             # Should show generated README
```

### Performance Testing

```bash
# Measure startup time
time coder create --template web3-dev-workspace perf-test

# Check resource usage
docker stats | grep coder

# Verify limits
docker inspect <container-id> | grep -A 10 "Memory"
```

## 🐛 Troubleshooting

### Common Issues

**Docker not accessible**
```bash
# Check socket exists
ls -l /var/run/docker.sock

# Check permissions
groups | grep docker

# Test Docker
docker info
```

**Tools not installing**
```bash
# Check network connectivity
curl -I https://github.com

# View script logs in Coder UI
# Templates → Your Template → Logs

# Manually run installation
cd /tmp
bash -x /path/to/development-tools-script.sh
```

**Out of memory/CPU**
```bash
# Check current limits
docker inspect <container> | grep -E "Memory|Cpu"

# Adjust in main.tf
variable "workspace_memory_gb" { default = 16 }
variable "workspace_cpus" { default = 8 }

# Update template
coder templates push web3-dev-workspace
```

**Workspace won't start**
```bash
# Check Coder logs
coder server logs

# Check template logs
coder templates describe web3-dev-workspace

# Check build logs
docker logs <builder-container>
```

## External Resources
- [Coder Documentation](https://coder.com/docs)
- [Terraform Coder Provider](https://registry.terraform.io/providers/coder/coder/latest/docs)
- [Docker Documentation](https://docs.docker.com)
- [Foundry Book](https://book.getfoundry.sh)
- [act Documentation](https://github.com/nektos/act)

## 🤝 Contributing

Contributions welcome! Here's how:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Setup

```bash
# Clone repo
git clone https://github.com/yourusername/coder-template.git
cd coder-template

# Make changes to main.tf or Dockerfile

# Test locally
terraform init
terraform validate
terraform fmt

# Push to test Coder instance
coder templates push test-template
```

## 📝 Changelog

### v2.0.0 (Current)
- ✨ Full Docker support via socket mount
- ✨ Smart tool installation with caching
- ✨ Resource limits (memory & CPU)
- ✨ Auto-generated workspace README
- ✨ Git aliases and shell shortcuts
- ✨ Enhanced VS Code setup
- ✨ Docker monitoring metrics
- ✨ Container health checks
- 🐛 Fixed systemd in containers
- ⚡ 40-60% faster startup after first boot
- 📦 15% smaller image size

### v1.x (Previous)
- Basic Docker client only
- Manual PostgreSQL setup
- Tool reinstallation on every start
- No resource limits
- Limited monitoring

## ⭐ Show Your Support

If this template helped you, please consider:
- ⭐ Starring the repository
- 🐛 Reporting bugs and suggesting features
- 📖 Improving documentation
- 🤝 Contributing code

---

**Built with ❤️ for the development community**
