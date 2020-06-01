# aws-fargate-cluster

My AWS ECS Fargate cluster deployment IaC.  Provisions a full stack including VPC, subnets, etc.  Includes an autoscaling AWS ECS Fargate Service behind a load balancer and exposed using TLS certificates via AWS Certificate Manager.  An additional container task is provisioned as a Scheduled task and executes every 10 minutes to "ping" the service.  Service Discovery is setup utilizing AWS Cloud Map and internal private DNS.

Additional enhancements made include setting up Custom Resources to provision a Fargate Spot capacity provider to the cluster and service for discounted pricing.  The `cdk-time-bomb` Construct is used to automatically destroy the entire stack after a set time (to avoid accidental bill shock after forgetting to tear down the CF stack).

## Limitations of AWS ECS Fargate

Some limitations of Fargate as a container orchestration platform were discovered.  The following represents my opinion of missing capabilities I believe to be important to Enterprise customers:

* Unable to `docker exec` or shell into a running container task.  Tools and techniques may need redesigned to accomodate debugging in development or disaster scenarios.  Most containerized "legacy" apps require some form of running ad-hoc commands within the container (MongoDB, Gitlab, etc).
* No support for network "links" or private internal networking such as with Docker Swarm.  Must use port mappings and AWS security groups over VPC network to allow container-to-container networking.  
* No built in "routing mesh" such as with Docker Swarm.  Internal service network load balancing can only be achieved thru native AWS ALB/NLB or a service mesh/proxy such as [AWS App Mesh](https://aws.amazon.com/about-aws/whats-new/2018/11/introducing-aws-app-mesh---service-mesh-for-microservices-on-aws/) or self hosted [Envoy Proxy](https://www.envoyproxy.io/)
* A number of [AWS Service Limits](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-quotas.html) for Fargate apply and may become troublesome as usage scales.  Default quotas can be increased upon request, but this must be anticipated and planned before production outages.
* Must implement additional scripting and use additional AWS services such as AWS CodeDeploy to achieve high availability during deployments to Fargate.  See write up on [Blue/Green deployments for Fargate](https://aws.amazon.com/blogs/devops/use-aws-codedeploy-to-implement-blue-green-deployments-for-aws-fargate-and-amazon-ecs/) for more details.
* Potential opportunity costs and proprietary orchestration vendor lock-in.  Learning and investing in AWS ECS Fargate as opposed to alternative, more vendor neutral options such as Kubernetes may be a risk.  
* Pricing for vCPU / RAM is more than bare metal EC2.  However, not having to manage infrastructure is the benefit.
