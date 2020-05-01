import * as cdk from "@aws-cdk/core";
import * as ec2 from "@aws-cdk/aws-ec2";
import * as ecs from "@aws-cdk/aws-ecs";
import * as ecs_patterns from "@aws-cdk/aws-ecs-patterns";
import { SubnetType } from "@aws-cdk/aws-ec2";
import acm = require("@aws-cdk/aws-certificatemanager");
import r53 = require("@aws-cdk/aws-route53");
import { CfnOutput } from "@aws-cdk/core";
import { ValidationMethod } from "@aws-cdk/aws-certificatemanager";
import * as logs from "@aws-cdk/aws-logs";

export class AwsFargateClusterStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const siteDomain = "belisleonline.com";
    const dnsName = "fargate-loadtest";

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

    const cluster = new ecs.Cluster(this, "FargateCluster", {
      vpc: vpc,
      clusterName: "FargateCluster",
      containerInsights: true,
    });

    const fargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(
      this,
      "FargateService",
      {
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
          })
        },
        certificate: cert,
        domainZone: zone,
        domainName: dnsName + "." + siteDomain,
      }
    );

    // Setup AutoScaling policy
    const scaling = fargateService.service.autoScaleTaskCount({
      maxCapacity: 3,
    });
    scaling.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 50,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    fargateService.targetGroup.configureHealthCheck({
      path: "/hello",
    });

    new cdk.CfnOutput(this, "LoadBalancerDNS", {
      value: fargateService.loadBalancer.loadBalancerDnsName,
    });
  }
}
