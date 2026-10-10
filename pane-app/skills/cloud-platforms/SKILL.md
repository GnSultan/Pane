---
name: cloud-platforms
description: Deployment models, IaaS/PaaS/serverless, infrastructure as code, managed services, cost optimization, and cloud-native design. Your code runs somewhere — understand where.
version: 1.0.0
tags: [cloud, aws, gcp, azure, cloudflare, serverless, kubernetes, containers, iaac, devops]
extends: []
conflicts: []
requires: []
provides: [cloud-platforms, cloud, deployment, serverless, kubernetes, iaac]
priority: 5
---

# Cloud Platforms

## When to use this skill
Activate when:
- Choosing a deployment model (VMs, containers, serverless, PaaS)
- Designing cloud architecture for a new service
- Writing infrastructure as code (Terraform, Pulumi, CloudFormation)
- Choosing between managed services vs. self-hosted
- Estimating and optimizing cloud costs
- Designing for multi-region or multi-cloud
- Setting up CI/CD pipelines
- Migrating from on-premise to cloud
- Comparing cloud providers for a specific workload

## First principle: rent, don't own

The cloud is not "someone else's computer." It's an API for infrastructure. You don't buy servers — you call an API that creates them. You don't configure a load balancer — you call an API that provisions one. Everything is programmable, ephemeral, and metered.

This fundamentally changes how you think: infrastructure is code, servers are cattle not pets, and everything you provision costs money every hour it exists. If nobody is using it right now, it should not exist right now.

## The deployment spectrum

### Bare metal / IaaS (Infrastructure as a Service)
**What:** You get a virtual machine. You install the OS, configure networking, deploy your app. AWS EC2, GCP Compute Engine, Azure VMs.
**When:** Maximum control needed. Specific kernel requirements. Legacy applications that can't be containerized. GPU workloads with specific driver requirements.
**Cost:** You pay for the VM whether it's busy or idle. You manage everything above the hypervisor.
**Rule:** This is the default only if nothing else works. You're doing undifferentiated heavy lifting.

### Containers / CaaS (Containers as a Service)
**What:** You provide a container image. The platform runs it. AWS ECS/EKS, GCP Cloud Run/GKE, Azure AKS.
**When:** You need more control than serverless but less than VMs. Long-running services. Applications that need background processing. You want to use standard container tooling.
**Cost:** You pay for the underlying compute (VMs for Kubernetes, or per-request for Cloud Run). You manage the container and its dependencies.

### PaaS (Platform as a Service)
**What:** You push code. The platform builds and runs it. Heroku, Render, Fly.io.
**When:** You want to focus on code, not infrastructure. Small-medium teams. You need something running quickly.
**Cost:** Higher per-unit than raw compute, lower operational cost. You trade money for time.
**Rule:** PaaS is the right default for most projects. The operational simplicity pays for itself.

### Serverless / FaaS (Function as a Service)
**What:** You write a function. It runs when triggered. You pay per invocation. AWS Lambda, Cloudflare Workers, Vercel Functions.
**When:** Event-driven workloads, unpredictable traffic, prototyping. Not for: long-running processes (>15 min), constant high traffic (cheaper on containers), workloads needing persistent connections (WebSockets are possible on some platforms but not all).
**Cost:** Zero when idle. Pay per request + duration. Can be dramatically cheaper or dramatically more expensive than containers depending on traffic pattern.
**Rule:** Serverless is the best choice for bursty, intermittent workloads. For steady high traffic, do the math — containers may be 10x cheaper.

### Edge compute
**What:** Your code runs in data centers close to users. Cloudflare Workers, Deno Deploy, Vercel Edge Functions.
**When:** Latency-sensitive operations. Lightweight request transformation. A/B testing. Authentication at the edge.
**Constraints:** Limited runtime (no Node.js native modules, no filesystem). Limited CPU time (typically 10-50ms on free tier). Great for what they're good at, terrible for what they're not.

## Kubernetes

### When Kubernetes and when NOT
**Use Kubernetes when:**
- You're running dozens or hundreds of services
- You need sophisticated deployment strategies (canary, blue-green, traffic splitting)
- You have a dedicated platform team
- Multi-cloud portability matters
- You need fine-grained resource scheduling

**Do NOT use Kubernetes when:**
- You have 1-5 services (use a PaaS or managed containers)
- You don't have anyone who understands Kubernetes operations
- Your traffic is predictable and low (serverless or PaaS is simpler)
- You're a startup shipping an MVP (ship first, Kubernetes later)
- You think "Kubernetes is the default" — it's not. It's a powerful, complex tool for specific problems.

### The complexity cost
Kubernetes adds: cluster management, node upgrades, network policies, RBAC, pod security policies, Helm charts, ingress controllers, cert-manager, service meshes (maybe), monitoring operators, log aggregation. Each of these is a project. Each has its own upgrade cadence and CVEs. If you don't need this power, it's just cost without benefit.

### Kubernetes-native patterns
- **Pod**: Smallest deployable unit. One or more containers sharing network and storage.
- **Deployment**: Manages replica sets. Declarative: "I want 3 pods running image:v2."
- **Service**: Stable network endpoint for pods. Pods come and go; the service IP stays.
- **Ingress**: HTTP routing. `/api` → api-service, `/` → web-service. TLS termination.
- **ConfigMap / Secret**: Configuration injected into pods without rebuilding images.
- **HorizontalPodAutoscaler**: Scale pods based on CPU/memory/custom metrics.
- **ServiceAccount**: Identity for pods to access the Kubernetes API and cloud resources.

## Infrastructure as Code (IaC)

Everything you provision in the cloud should be defined in code. Not clicked in a console. Not created by running a script once and forgetting. Code, in version control, reviewed, tested, deployed.

### Terraform (the pragmatic default)
HashiCorp Configuration Language (HCL). Declarative. Provider ecosystem (AWS, GCP, Azure, Cloudflare, GitHub, Datadog — everything).

```
resource "aws_instance" "web" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.micro"

  tags = {
    Name = "web-server"
  }
}
```

**State file**: Terraform tracks what it created in a state file. This is the source of truth for what exists. Store it remotely (S3, Terraform Cloud) with locking. Never commit it to git (it contains secrets). If you lose it, you can't manage your infrastructure without importing everything.

**Modules**: Reusable groups of resources. A `vpc` module, a `database` module, a `web-service` module. Write once, use across environments (dev, staging, prod).

### Pulumi
Infrastructure as actual code (TypeScript, Python, Go). No HCL. Loops, conditionals, functions — all in your language of choice.

```typescript
const server = new aws.ec2.Instance("web", {
  ami: "ami-0c55b159cbfafe1f0",
  instanceType: "t3.micro",
  tags: { Name: "web-server" },
});
```

**When to choose Pulumi over Terraform:** Your infrastructure has complex logic (loops, conditionals) that HCL handles poorly. Your team is stronger in general-purpose languages than DSLs. You want to share code between application and infrastructure.

### Principles of IaC
- **Idempotency**: Running the same configuration twice produces the same infrastructure. No "already exists" errors.
- **Immutability**: Don't update servers. Destroy and recreate with the new configuration. Immutable infrastructure eliminates configuration drift.
- **Environments from the same code**: Dev, staging, prod should be identical except for scale. Differences should be explicit variables, not one-off tweaks.
- **Secrets never in code**: Use secret references (`aws_secretsmanager_secret_version`), environment variables from a vault, or encrypted values. Never a plaintext password in a `.tf` file.
- **Review before apply**: IaC changes go through PR review like any other code. "I changed a security group to allow 0.0.0.0/0" should be caught in review, not in production.

## Managed services vs. self-hosted

The cloud has a managed service for everything. Database, queue, cache, search, email, CDN, Kubernetes, functions, AI models. When to use them vs. self-hosting:

### Use managed services when:
- **It's not your core competency.** Running PostgreSQL is not your business. Selling your product is.
- **The operational burden is high.** Elasticsearch clusters that need babysitting. Kafka clusters that lose partitions. Database backups that only work until you need them. Managed services eliminate this.
- **You don't have 24/7 operations.** At 3 AM, AWS is awake. Your team is not.
- **The managed version has better properties.** Cloudflare's DDoS protection is better than yours. AWS's S3 durability (11 nines) is better than your RAID array.

### Self-host when:
- **Cost at scale.** Managed databases at $0.50/hour are cheaper than a DBA. At 100 instances running 24/7, the math changes.
- **Specific requirements.** The managed service doesn't support the extension you need. The instance size you need doesn't exist.
- **Data locality.** Data must stay in a specific physical location that the managed service doesn't offer.
- **Vendor lock-in is unacceptable.** Though the cost of lock-in is often less than the cost of avoiding it.

### The managed service trap
Managed services lower operational burden but increase dependency. If AWS RDS goes down, you can't fix it — you wait. If the managed service increases prices 3x, you pay or you migrate (which takes months). If they deprecate the instance type you use, you must migrate. These are real risks. Evaluate them honestly.

## Cloud design principles

### Design for failure
Everything fails. A VM disappears. An AZ goes down. A region has an outage. Design for each level:
- **Instance failure**: Auto-scaling groups replace dead instances. Stateless services (state in managed database, not local disk).
- **AZ failure**: Multi-AZ databases. Load balancers across AZs. If one AZ goes down, the other handles traffic.
- **Region failure**: Multi-region architecture. DNS failover. Data replicated across regions. This is expensive. Most applications don't need it — the business interruption cost must exceed the multi-region infrastructure cost.

### Right-size your resources
The cloud makes it easy to over-provision. "Just give it 16 GB of RAM to be safe." At scale, that waste is enormous. Monitor utilization. Rightsize. The cloud bills by the hour — every hour of over-provisioning is money wasted.

### Use spot/preemptible instances
AWS Spot, GCP Preemptible, Azure Spot VMs: 60-90% cheaper, but can be terminated with 2 minutes notice. Perfect for:
- Batch processing
- CI/CD workers
- Stateless services that can handle instance termination
- Dev/staging environments

Don't use for databases or anything that can't recover from sudden termination. Use a mix: spot for burst capacity, on-demand for baseline.

### Network costs
People worry about compute costs but forget network costs. Data transfer between AZs, between regions, out to the internet — all metered, all expensive at scale.
- Keep traffic within the same AZ when possible
- Use a CDN to serve from the edge (cheaper egress, better latency)
- Cache aggressively (every cache hit is a database query and network call avoided)
- Monitor network costs separately — they're easy to miss until the bill arrives

### Tag everything
Every resource needs tags: `Environment: prod`, `Service: payment-api`, `Team: payments`, `CostCenter: eng-platform`. Without tags, you can't answer "how much does the payments service cost?" or "what resources does the payments team own?" or "can I shut down everything in staging?" Tagging is boring and essential.

## Cloud provider comparison

| | AWS | GCP | Azure | Cloudflare |
|---|---|---|---|---|
| **Strength** | Everything. First to market. | Data/AI. Kubernetes (they invented it). | Enterprise. Active Directory integration. | Edge. DDoS. Zero-latency cold starts. |
| **Weakness** | Complexity. The console is 200+ services. | Smaller ecosystem. Less enterprise penetration. | Less developer-friendly. Documentation gaps. | Limited compute runtime. Not for traditional apps. |
| **Compute** | EC2, Lambda, ECS/EKS | Compute Engine, Cloud Run, GKE | VMs, Azure Functions, AKS | Workers |
| **Database** | RDS, Aurora, DynamoDB | Cloud SQL, Spanner, Firestore | SQL Database, Cosmos DB | D1 (SQLite at edge) |
| **Storage** | S3 (the standard) | Cloud Storage | Blob Storage | R2 (zero egress fees) |
| **Best for** | Startups to enterprise. Needs everything. | ML/AI workloads. Container-native. | Microsoft shops. Hybrid cloud. | Edge compute. JAMstack. Security-first. |

**Recommendation for new projects:** AWS if you need the broadest service catalog. GCP if you're container-native or ML-focused. Cloudflare for edge-first applications (Workers + D1 + R2 + KV). Azure only if you're in the Microsoft ecosystem.

## Cost optimization

### The cloud cost hierarchy (cheapest to most expensive)
1. **Don't run it**: The cheapest compute is no compute. Delete unused resources. Shut down staging on weekends.
2. **Spot/preemptible**: 60-90% off for interruptible workloads.
3. **Reserved instances / committed use**: 30-50% off for 1-3 year commitment. Good for stable baseline.
4. **On-demand**: The default. Pay as you go. No commitment.
5. **Provisioned capacity**: You pay whether you use it or not (e.g., DynamoDB provisioned capacity, RDS reserved at the wrong size).

### Architectural cost patterns
- **Serverless for sparse traffic**: 1M requests/day on Lambda is ~$0.60. 1M requests/day on an always-on t3.micro is ~$8.50 (the instance, not the requests). At 10M requests/day, Lambda is ~$6 and the EC2 is still ~$8.50. At 100M/day, Lambda is ~$60 and EC2 is still ~$8.50. Know your break-even.
- **CDN for static content**: Serving a 1MB image from S3: $0.00009 storage + $0.00009 per GET. From CloudFront: $0.000085 per GET (US). CDN is cheaper AND faster. Always use a CDN for static content.
- **S3 lifecycle policies**: Transition to cheaper storage tiers automatically. Infrequently accessed → S3-IA (50% cheaper). Archive → Glacier (80% cheaper). Delete after retention period. Set this up on day one, not when your S3 bill is $10K.
- **Database connection pooling**: Each connection consumes database resources. Use a connection pooler (PgBouncer, RDS Proxy). Serverless functions that open a new connection per invocation will overwhelm your database.

### The architecture cost tax
Every architectural decision has a long-term cost. Microservices? You're paying for inter-service communication, separate deployments, and operational overhead. Event sourcing? You're paying for event storage and replay infrastructure. Multi-region? You're paying for data transfer and replica instances. These costs are often justified, but they must be justified — not just assumed.

## CI/CD

### The deployment pipeline
```
Push → Build → Test → Stage → Approve → Deploy → Verify
```

Each stage is a gate. If tests fail, stop. If the staging deploy fails, stop. If the canary shows elevated errors, rollback.

### Deployment strategies
- **Rolling**: Replace instances one at a time. Slow. Safe. Standard.
- **Blue-green**: Deploy new version alongside old. Switch traffic all at once. Fast rollback (switch back). Double the infrastructure during deploy.
- **Canary**: Deploy to 5% of traffic. Monitor. If healthy, 25%, 50%, 100%. Catches problems before they affect everyone. Requires traffic splitting infrastructure.
- **Feature flags**: Deploy code dark. Enable feature per-user, per-team, per-region. Separates deploy from release. The most powerful pattern — and the most complex.

### What belongs in CI
- Linting and formatting
- Type checking
- Unit tests
- Integration tests (with service dependencies — use testcontainers or docker-compose)
- Build artifact (container image, bundle)
- Security scanning (dependency vulnerabilities, static analysis)

### What belongs in CD
- Infrastructure provisioning (Terraform plan/apply)
- Database migrations (forward AND backward — every migration needs a down)
- Deployment (rolling, blue-green, or canary)
- Smoke tests (did the deploy work? can users log in?)
- Rollback procedure (automated, tested, fast)

## Security in the cloud

(Detailed security in the `security` skill. Here only cloud-specific aspects.)

### The shared responsibility model
- **Cloud provider is responsible for** security OF the cloud: physical data centers, network infrastructure, hypervisor.
- **You are responsible for** security IN the cloud: your data, your application, your access controls, your configuration.

"AWS is secure" does not mean "my S3 bucket is secure." AWS securing their data center does not prevent you from making your S3 bucket public. The most common cloud security incidents are customer misconfigurations, not provider breaches.

### Identity and access
- **IAM roles, not IAM users.** Roles are assumed by services. Users have long-lived credentials. Roles are temporary and rotated automatically.
- **Least privilege.** Every service should have access to exactly what it needs and nothing else. "Read from this S3 bucket." Not "Full S3 access."
- **No wildcards.** `s3:*` is not a policy — it's an incident waiting to happen.
- **No hardcoded credentials.** No access keys in code, config files, or environment variables committed to git. Use instance roles, workload identity, or a secrets manager.

### Network security
- **Security groups**: Allow-list. "Allow port 443 from the load balancer security group." Default deny all.
- **Private subnets**: Databases, caches, internal services go in private subnets (no direct internet access). Only load balancers and bastion hosts get public IPs.
- **Never open 0.0.0.0/0** except for public-facing services that should be public. If you need to SSH, use SSM Session Manager (AWS) or Identity-Aware Proxy (GCP) — not an open SSH port.
- **Encryption in transit**: TLS everywhere. Between services, between AZs, between regions. Managed services often support TLS by default — enable it.

### Data security
- **Encryption at rest**: Enable it. Every managed service supports it. The performance overhead is negligible. The operational overhead is zero (cloud providers manage keys by default).
- **Key management**: Use KMS/Cloud KMS/Key Vault. Don't store encryption keys alongside data. Rotate keys automatically.
- **Backups**: Automated, encrypted, tested. A backup you haven't tested restoring is not a backup — it's a hope.

## Cloud-native anti-patterns

### Lifting and shifting
Moving a VM from your data center to EC2 without changing anything. You now have all the problems of on-premise (manual configuration, pets not cattle, fragile infrastructure) plus cloud costs. The goal of cloud migration is to adopt cloud-native patterns, not to move your problems to someone else's computer.

### Over-engineering for scale you don't have
"We need Kubernetes because when we have 10 million users..." You have 100 users. Build for 100. You can scale to 10 million later if you survive long enough. Premature scaling is premature optimization applied to infrastructure.

### Multi-cloud for multi-cloud's sake
"We must be cloud-agnostic. We'll abstract away every provider's API behind our own abstraction layer." Now you have a worse version of every cloud service, maintained by your team, that none of your new hires know. The cost of building and maintaining a multi-cloud abstraction almost always exceeds the cost of being locked in. Pick a cloud. Use its services well. If you need to switch later, the migration cost will be less than the abstraction cost.

### Console-driven infrastructure
"Bob created this S3 bucket manually. It's not in Terraform. Nobody knows what it does. We're afraid to delete it." Infrastructure not in code is mystery infrastructure. It accumulates until nobody understands the system.

### Unlimited environments
"Every pull request gets its own full environment." At 50 PRs open simultaneously, you have 50 full stacks running 24/7. The bill arrives and nobody understood what they were opting into. Preview environments are useful. Limit how many can exist, auto-destroy after merge, and make their cost visible.

### Ignoring cloud-specific limits
Every cloud service has limits: Lambda 15-minute timeout, S3 eventual consistency on overwrites, API Gateway 30-second timeout, DynamoDB 400KB item size. These are hard limits. They cannot be exceeded. Design within them from the start — not around them after you hit them in production.

## Practical defaults for new projects

| Requirement | Default choice |
|---|---|
| **Simple web app** | PaaS (Render, Fly.io) + managed Postgres |
| **API that might scale** | Containers (ECS/Cloud Run) + managed Postgres + Redis |
| **Edge-first app** | Cloudflare Workers + D1 + R2 |
| **Data-intensive / ML** | GCP (BigQuery, Vertex AI) |
| **Enterprise / Microsoft shop** | Azure |
| **Static site** | Cloudflare Pages or Vercel + CDN |
| **CI/CD** | GitHub Actions (simplest integration) |
| **IaC** | Terraform (widest ecosystem) |
| **Monitoring** | OpenTelemetry → Grafana Cloud or Datadog |
| **Secrets** | AWS Secrets Manager / GCP Secret Manager / env encrypted at rest |
