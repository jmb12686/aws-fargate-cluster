import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as ecs from '@aws-cdk/aws-ecs';
import * as ecs_patterns from '@aws-cdk/aws-ecs-patterns';

export class AwsFargateClusterStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "FargateVPC", {
      maxAzs: 3
    });

    const cluster = new ecs.Cluster(this, "FargateCluster", {
      vpc: vpc,
      clusterName: 'FargateCluster'
    });

    const fargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, "FargateService",{
      cluster: cluster,
      cpu: 512,
      desiredCount: 1,
      memoryLimitMiB: 1024,
      publicLoadBalancer: true,
      // listenerPort:
      // taskDefinition:
      taskImageOptions: {
        image: ecs.ContainerImage.fromRegistry('jmb12686/go-loadtest-api'),
        containerPort: 8000
      },
    });

    // Setup AutoScaling policy
    const scaling = fargateService.service.autoScaleTaskCount({ maxCapacity: 2 });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 50,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60)
    });

    new cdk.CfnOutput(this, 'LoadBalancerDNS', { value: fargateService.loadBalancer.loadBalancerDnsName });
  }
}
