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
import { NamespaceType } from "@aws-cdk/aws-servicediscovery";
import { Schedule } from "@aws-cdk/aws-applicationautoscaling";
import { CfnService } from "@aws-cdk/aws-ecs";
import { CfnRule } from "@aws-cdk/aws-events";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
} from "@aws-cdk/custom-resources";
import { PolicyStatement, Effect } from "@aws-cdk/aws-iam";

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
      defaultCloudMapNamespace: {
        name: "fargate.pvt",
        type: NamespaceType.DNS_PRIVATE,
        vpc: vpc,
      },
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
          }),
        },
        certificate: cert,
        domainZone: zone,
        domainName: dnsName + "." + siteDomain,
        cloudMapOptions: {
          name: "loadtest",
          failureThreshold: 1,
        },
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

    // Configure Scheduled Fargate Task
    const scheduledFargateTask = new ecs_patterns.ScheduledFargateTask(
      this,
      "ScheduledFargateTask",
      {
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
      }
    );

    //Didn't work, didn't even create a new sec group or rule
    // fargateService.service.connections.allowFrom(scheduledFargateTask.cluster, ec2.Port.allTcp(), "Allow All TCP traffic from fargate cluster?");

    // This created a security group, and added it to allowed outbound from load balancer (i.e. inncorect)
    // const securityGroup = new ec2.SecurityGroup(this, "AllowTrafficFromTask", {
    //   vpc: vpc,
    //   allowAllOutbound: true,
    //   description: "Allow traffic from fargate task",
    //   securityGroupName: "AllowTrafficFromFargateTask"
    // });
    // securityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.allTcp(), "Allow all VPC traffic");
    // fargateService.service.connections.addSecurityGroup(securityGroup);

    //Attempt modifying created security group?
    fargateService.service.connections.securityGroups[0].addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.allTcp(),
      "Allow all VPC traffic"
    );

    const constructs: any[] = scheduledFargateTask.node.findAll();
    for (let construct of constructs) {
      console.log("construct=" + construct);
    }
    const cfnRule = scheduledFargateTask.eventRule.node.findChild(
      "Resource"
    ) as CfnRule;
    console.log("scheduledEventRule = " + cfnRule);
    // cfnRule.
    // console.log(JSON.stringify(cfnRule));

    //CUSTOM RESOURCE WORK TO UPDATE FARGATE CLUSTER CAPACITY PROVIDER TO SPOT!
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

    new cdk.CfnOutput(this, "LoadBalancerDNS", {
      value: fargateService.loadBalancer.loadBalancerDnsName,
    });
  }
}
