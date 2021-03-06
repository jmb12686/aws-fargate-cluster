import * as cdk from "@aws-cdk/core";
import * as ec2 from "@aws-cdk/aws-ec2";
import * as ecs from "@aws-cdk/aws-ecs";
import * as ecs_patterns from "@aws-cdk/aws-ecs-patterns";
import { SubnetType } from "@aws-cdk/aws-ec2";
import acm = require("@aws-cdk/aws-certificatemanager");
import r53 = require("@aws-cdk/aws-route53");
import { CfnOutput, Duration } from "@aws-cdk/core";
import { ValidationMethod } from "@aws-cdk/aws-certificatemanager";
import * as logs from "@aws-cdk/aws-logs";
import { NamespaceType } from "@aws-cdk/aws-servicediscovery";
import { Schedule } from "@aws-cdk/aws-applicationautoscaling";
import { CfnService } from "@aws-cdk/aws-ecs";
import { CfnRule } from "@aws-cdk/aws-events";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
} from "@aws-cdk/custom-resources";
import { PolicyStatement, Effect } from "@aws-cdk/aws-iam";
import { SelfDestruct } from "cdk-time-bomb";

export class AwsFargateClusterStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const selfDestruct = new SelfDestruct(this, "selfDestructor", {
      timeToLive: Duration.minutes(120),
    });

    const vpc = new ec2.Vpc(this, "FargateVPC", {
      maxAzs: 3,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "FargatePublicSubnet",
          subnetType: SubnetType.PUBLIC,
        },
      ],
      natGateways: 0,
    });

    vpc.node.addDependency(selfDestruct);

    const siteDomain = "belisleonline.com";
    const dnsName = "fargate.loadtest";

    // Create new certificate
    const cert = new acm.Certificate(this, "FargateCertificate", {
      domainName: dnsName + "." + siteDomain,
      validationDomains: {
        domainName: siteDomain,
      },
      validationMethod: ValidationMethod.DNS,
    });

    // Get the existing Route53 hosted zone that already exists
    const zone = r53.HostedZone.fromLookup(this, "MyZone", {
      domainName: siteDomain,
    });

    // Create Fargate Cluster
    const cluster = new ecs.Cluster(this, "FargateCluster", {
      vpc: vpc,
      clusterName: "FargateCluster",
      containerInsights: true,
      // Enable CloudMap for container service discovery via DNS
      defaultCloudMapNamespace: {
        name: "fargate.pvt",
        type: NamespaceType.DNS_PRIVATE,
        vpc: vpc,
      },
    });

    // Create Fargate Service
    const fargateService = this.buildAutoscalingService(cluster, cert, zone, dnsName, siteDomain);

    // Configure Scheduled Fargate Task
    const scheduledFargateTask = this.buildScheduledTask(vpc, cluster);

    //Modify created security group to allow traffic from all of our VPC to our Fargate Service
    fargateService.service.connections.securityGroups[0].addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.allTcp(),
      "Allow all VPC traffic"
    );

    // CUSTOM RESOURCE WORK TO UPDATE FARGATE CLUSTER CAPACITY PROVIDER TO SPOT!
    const capacityProviderCustomResource = this.buildFargateSpotCapProviderCR(
      cluster
    );
    const updateServiceFargateSpotCustomResource = this.updateServiceCapacityProvider(
      cluster,
      fargateService
    );
    // Force dependency ordering to provision Fargate Spot capacity provider after service is created
    fargateService.node.addDependency(capacityProviderCustomResource);
    updateServiceFargateSpotCustomResource.node.addDependency(
      capacityProviderCustomResource
    );

    new cdk.CfnOutput(this, "LoadBalancerDNS", {
      value: fargateService.loadBalancer.loadBalancerDnsName,
    });
  }

  private buildScheduledTask(vpc: ec2.Vpc, cluster: ecs.Cluster) {
    return new ecs_patterns.ScheduledFargateTask(this, "ScheduledFargateTask", {
      vpc: vpc,
      cluster: cluster,
      schedule: Schedule.rate(cdk.Duration.minutes(10)),
      desiredTaskCount: 1,
      subnetSelection: {
        subnetType: SubnetType.PUBLIC,
      },
      scheduledFargateTaskImageOptions: {
        image: ecs.ContainerImage.fromRegistry("curlimages/curl"),
        command: [
          "-L",
          "-v",
          "http://loadtest.fargate.pvt:8000/loadtest/iterations/10000",
        ],
        cpu: 256,
        memoryLimitMiB: 512,
        logDriver: ecs.LogDrivers.awsLogs({
          streamPrefix: "ScheduledFargateLoadtestTask",
          logRetention: logs.RetentionDays.TWO_MONTHS,
        }),
      },
    });
  }

  private buildAutoscalingService(cluster: ecs.Cluster, cert: acm.Certificate, zone: r53.IHostedZone, dnsName: string, siteDomain: string) {
    const fargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, "FargateService", {
      cluster: cluster,
      assignPublicIp: true,
      cpu: 256,
      desiredCount: 1,
      memoryLimitMiB: 512,
      publicLoadBalancer: true,
      taskImageOptions: {
        image: ecs.ContainerImage.fromRegistry("jmb12686/go-loadtest-api"),
        containerPort: 8000,
        logDriver: ecs.LogDrivers.awsLogs({
          streamPrefix: "FargateLoadtest",
          logRetention: logs.RetentionDays.TWO_MONTHS,
        }),
      },
      certificate: cert,
      domainZone: zone,
      domainName: dnsName + "." + siteDomain,
      // Add DNS name to AWS Cloud Map for container service discovery
      cloudMapOptions: {
        name: "loadtest",
        failureThreshold: 1,
      },
    });
    // Setup AutoScaling policy
    const scaling = fargateService.service.autoScaleTaskCount({
      maxCapacity: 6,
    });
    scaling.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 50,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });
    fargateService.targetGroup.configureHealthCheck({
      path: "/hello",
    });
    return fargateService;
  }

  private updateServiceCapacityProvider(
    cluster: ecs.Cluster,
    fargateService: ecs_patterns.ApplicationLoadBalancedFargateService
  ) {
    const policyStatement: PolicyStatement = new PolicyStatement({
      effect: Effect.ALLOW,
    });
    policyStatement.addAllResources();
    policyStatement.addActions("*");
    const customResourcePolicy: AwsCustomResourcePolicy = AwsCustomResourcePolicy.fromStatements(
      [policyStatement]
    );
    const customResource = new AwsCustomResource(
      this,
      "ServiceCapacityProviderCustomResource",
      {
        policy: customResourcePolicy,
        onCreate: {
          service: "ECS",
          action: "updateService",
          parameters: {
            cluster: cluster.clusterName,
            service: fargateService.service.serviceName,
            capacityProviderStrategy: [
              {
                capacityProvider: "FARGATE_SPOT",
                base: "0",
                weight: "1",
              },
            ],
            forceNewDeployment: true,
          },
          physicalResourceId: {
            id: "FargateServiceSpotCustomResource" + Date.now().toString(),
          },
          outputPath: "service.capacityProviderStrategy", //Restrict the data coming back from this api call due to 4k response limit in CF custom resource
        },
      }
    );
    return customResource;
  }

  private buildFargateSpotCapProviderCR(cluster: ecs.Cluster) {
    const policyStatement: PolicyStatement = new PolicyStatement({
      effect: Effect.ALLOW,
    });
    policyStatement.addAllResources();
    policyStatement.addActions("*");
    const customResourcePolicy: AwsCustomResourcePolicy = AwsCustomResourcePolicy.fromStatements(
      [policyStatement]
    );
    const capacityProviderCustomResource = new AwsCustomResource(
      this,
      "FargateCapacityProviderCustomResource",
      {
        policy: customResourcePolicy,
        onCreate: {
          service: "ECS",
          action: "putClusterCapacityProviders",
          parameters: {
            capacityProviders: ["FARGATE", "FARGATE_SPOT"],
            cluster: cluster.clusterName,
            defaultCapacityProviderStrategy: [
              {
                capacityProvider: "FARGATE_SPOT",
                weight: 1,
              },
            ],
          },
          physicalResourceId: {
            id: "FargateSpotCustomResource" + Date.now().toString(),
          },
        },
      }
    );
    return capacityProviderCustomResource;
  }
}
