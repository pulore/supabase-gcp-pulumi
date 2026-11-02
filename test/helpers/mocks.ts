/**
 * Pulumi runtime mocks for the unit tests. No cloud APIs are called: every
 * resource the program registers is recorded here with its inputs, and given
 * a fake ID plus the few computed outputs the program reads (IP addresses,
 * secret version names, the generated certificate).
 */
import * as fs from "fs";
import * as path from "path";

import * as pulumi from "@pulumi/pulumi";

export interface RecordedResource {
  type: string;
  name: string;
  inputs: Record<string, any>;
  id: string;
}

export const recorded: RecordedResource[] = [];

/** A real self-signed certificate (no key kept), standing in for tls.SelfSignedCert. */
export const TEST_CERT_PEM = fs.readFileSync(path.join(__dirname, "..", "fixtures", "outline-test-cert.pem"), "utf8");

/** SHA-256 of TEST_CERT_PEM, computed with `openssl x509 -noout -sha256 -fingerprint`. */
export const TEST_CERT_SHA256 = "3B806103C7DC87B863C24C4604AAFEAA82FB9EA86FA69A937E92668083A94727";

export const VPN_IP = "203.0.113.10";
export const LB_IP = "198.51.100.20";
export const DB_PRIVATE_IP = "10.20.0.3";

/** What each random.RandomPassword resolves to, so tests can search for leaks. */
export function mockSecretValue(resourceName: string): string {
  return `MOCKSECRET${resourceName.replace(/[^A-Za-z0-9]/g, "")}`;
}

export const MOCK_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nMOCKSECRETPRIVATEKEY\n-----END PRIVATE KEY-----\n";

function computedOutputs(type: string, name: string, inputs: Record<string, any>): Record<string, unknown> {
  switch (type) {
    case "random:index/randomPassword:RandomPassword":
      return { result: mockSecretValue(name) };
    case "random:index/randomString:RandomString":
      return { result: "mocksalt" };
    case "tls:index/privateKey:PrivateKey":
      return { privateKeyPem: MOCK_PRIVATE_KEY };
    case "tls:index/selfSignedCert:SelfSignedCert":
      return { certPem: TEST_CERT_PEM };
    case "gcp:compute/address:Address":
      return { address: VPN_IP };
    case "gcp:compute/globalAddress:GlobalAddress":
      return { address: inputs.purpose === "VPC_PEERING" ? "10.20.0.0" : LB_IP };
    case "gcp:sql/databaseInstance:DatabaseInstance":
      return { privateIpAddress: DB_PRIVATE_IP, connectionName: `test-project:${inputs.region}:${name}` };
    case "gcp:serviceaccount/account:Account":
      return { email: `${inputs.accountId}@test-project.iam.gserviceaccount.com` };
    case "gcp:secretmanager/secret:Secret":
      return { secretId: inputs.secretId };
    case "gcp:secretmanager/secretVersion:SecretVersion":
      return { name: `projects/123456789/secrets/${name}/versions/1`, version: "1" };
    case "gcp:compute/instanceTemplate:InstanceTemplate":
      return { selfLinkUnique: `https://www.googleapis.com/compute/v1/projects/test-project/global/instanceTemplates/${name}?uniqueId=1` };
    case "gcp:compute/regionInstanceGroupManager:RegionInstanceGroupManager":
      return {
        instanceGroup: `https://www.googleapis.com/compute/v1/projects/test-project/regions/${inputs.region}/instanceGroups/${inputs.name}`,
      };
    default:
      return {};
  }
}

/** Installs the mocks and the stack config. Call before importing the program. */
export async function setupMocks(config: Record<string, string>, stack = "dev"): Promise<void> {
  await pulumi.runtime.setMocks(
    {
      newResource(args: pulumi.runtime.MockResourceArgs): pulumi.runtime.MockResourceResult {
        const id = `${args.name}-id`;
        recorded.push({ type: args.type, name: args.name, inputs: args.inputs, id });
        return {
          id,
          state: {
            name: args.name,
            selfLink: `https://www.googleapis.com/compute/v1/projects/test-project/${args.name}`,
            ...args.inputs,
            ...computedOutputs(args.type, args.name, args.inputs),
          },
        };
      },
      call(args: pulumi.runtime.MockCallArgs): pulumi.runtime.MockCallResult {
        throw new Error(`unexpected data source call in tests: ${args.token}`);
      },
    },
    "supabase-gcp",
    stack,
    false,
  );
  pulumi.runtime.setAllConfig(config);
}

/** Resolves an Output's value. */
export function valueOf<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((resolve) => output.apply((value) => resolve(value)));
}

/**
 * Waits until no new resources have been registered for `quietMs`. Resources
 * register asynchronously, as their inputs resolve.
 */
export async function settle(quietMs = 300, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  let count = -1;
  let since = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (recorded.length !== count) {
      count = recorded.length;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) {
      return;
    }
  }
  throw new Error("resources were still being registered after 30 seconds");
}

export function ofType(type: string): RecordedResource[] {
  return recorded.filter((resource) => resource.type === type);
}

/** The one resource of `type`, or the one named `name` if several exist. */
export function one(type: string, name?: string): RecordedResource {
  const matches = ofType(type).filter((resource) => name === undefined || resource.name === name);
  if (matches.length !== 1) {
    throw new Error(`expected one ${type}${name ? ` named ${name}` : ""}, found ${matches.length}`);
  }
  return matches[0];
}

export const TYPES = {
  autoscaler: "gcp:compute/regionAutoscaler:RegionAutoscaler",
  backendService: "gcp:compute/backendService:BackendService",
  firewall: "gcp:compute/firewall:Firewall",
  forwardingRule: "gcp:compute/globalForwardingRule:GlobalForwardingRule",
  healthCheck: "gcp:compute/healthCheck:HealthCheck",
  instance: "gcp:compute/instance:Instance",
  instanceTemplate: "gcp:compute/instanceTemplate:InstanceTemplate",
  managedCertificate: "gcp:compute/managedSslCertificate:ManagedSslCertificate",
  mig: "gcp:compute/regionInstanceGroupManager:RegionInstanceGroupManager",
  network: "gcp:compute/network:Network",
  secret: "gcp:secretmanager/secret:Secret",
  secretIam: "gcp:secretmanager/secretIamMember:SecretIamMember",
  securityPolicy: "gcp:compute/securityPolicy:SecurityPolicy",
  serviceNetworkingConnection: "gcp:servicenetworking/connection:Connection",
  sqlInstance: "gcp:sql/databaseInstance:DatabaseInstance",
} as const;
