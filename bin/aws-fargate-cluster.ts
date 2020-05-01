#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "@aws-cdk/core";
import { AwsFargateClusterStack } from "../lib/aws-fargate-cluster-stack";

const app = new cdk.App();

const env: cdk.Environment = {
  account: process.env.CDK_DEPLOY_ACCOUNT || process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEPLOY_REGION || process.env.CDK_DEFAULT_REGION,
};

console.log("env object=" + JSON.stringify(env));

new AwsFargateClusterStack(app, "AwsFargateClusterStack", { env: env });
