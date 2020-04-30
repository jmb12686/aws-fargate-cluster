#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { AwsFargateClusterStack } from '../lib/aws-fargate-cluster-stack';

const app = new cdk.App();
new AwsFargateClusterStack(app, 'AwsFargateClusterStack');
