"""Real API-only k3s SSA; no Pod readiness proof or production credentials."""

import os
import unittest
from copy import deepcopy
from pathlib import Path

from kubernetes import client, config
from personal_cloud.deployment.kubernetes import Client, DependencyUnavailable
from personal_cloud.deployment.reconcile import declared_view
from personal_cloud.deployment.resources import Renderer

from .test_release import CONFIG, IDENTITY, TARGETS, asset


@unittest.skipUnless(os.environ.get("K3S_ACCEPTANCE_DIR"), "isolated k3s only")
class K3sAcceptance(unittest.TestCase):
    def test_real_ssa_restore_noop_conflict_and_persistent_objects(self):
        directory = Path(os.environ["K3S_ACCEPTANCE_DIR"])
        admin = config.new_client_from_config(str(directory / "kubeconfig"))
        self.addCleanup(admin.close)
        self.assertEqual(admin.configuration.host, "https://127.0.0.1:6443")
        kube = Client(
            CONFIG.namespace,
            origin="https://127.0.0.1:6443",
            token_file=str(directory / "token"),
            ca_file=str(directory / "ca.crt"),
        )
        self.addCleanup(kube.close)
        core = client.CoreV1Api(admin)
        secret = core.create_namespaced_secret(
            CONFIG.namespace,
            {
                "apiVersion": "v1",
                "kind": "Secret",
                "metadata": {"name": "newsletter-settings"},
                "stringData": {"TEST": "isolated-fixture-only"},
            },
        )
        pvc = core.create_namespaced_persistent_volume_claim(
            CONFIG.namespace,
            {
                "apiVersion": "v1",
                "kind": "PersistentVolumeClaim",
                "metadata": {"name": "newsletter-data"},
                "spec": {
                    "accessModes": ["ReadWriteOnce"],
                    "storageClassName": "",
                    "resources": {"requests": {"storage": "1Mi"}},
                },
            },
        )
        resources = Renderer(CONFIG, asset=asset()).render(TARGETS, IDENTITY)
        wanted = next(
            item
            for item in resources
            if (item["kind"], item["metadata"]["name"]) == ("Deployment", "newsletter")
        )
        metadata = next(
            item
            for item in resources
            if item["metadata"]["name"] == "platform-runtime-config"
        )
        kube.apply(wanted)
        kube.apply(metadata)

        # Real dry-run must not write a manifest or change its generation/identity.
        before = kube.get("ConfigMap", "platform-runtime-config")
        deployment = kube.get("Deployment", "newsletter")["metadata"]
        for declaration in (wanted, metadata):
            applied = kube.dry_run(declaration)
            self.assertEqual(declared_view(applied, declaration), declaration)
        self.assertEqual(
            kube.get("ConfigMap", "platform-runtime-config")["metadata"][
                "resourceVersion"
            ],
            before["metadata"]["resourceVersion"],
        )
        current = kube.get("Deployment", "newsletter")["metadata"]
        for field in ("uid", "generation"):
            self.assertEqual(current[field], deployment[field])

        # Same-manager drift is repairable. Foreign-manager ownership is separate.
        drift = deepcopy(wanted)
        pod = drift["spec"]["template"]["spec"]
        pod["securityContext"]["runAsUser"] = 10002
        pod["volumes"][0]["persistentVolumeClaim"]["claimName"] = "wrong-data"
        pod["containers"][0]["readinessProbe"]["httpGet"]["path"] = "/broken"
        pod["containers"][0]["image"] = "example.invalid/fixture:wrong"
        kube.apply(drift)
        self.assertNotEqual(
            declared_view(kube.get("Deployment", "newsletter"), wanted), wanted
        )
        self.assertEqual(declared_view(kube.dry_run(wanted), wanted), wanted)
        kube.apply(wanted)
        restored = kube.get("Deployment", "newsletter")
        self.assertEqual(declared_view(restored, wanted), wanted)
        self.assertEqual(restored["metadata"]["uid"], deployment["uid"])

        # Only this isolated fixture's admin steals ownership to provoke real 409s.
        admin.call_api(
            "/apis/apps/v1/namespaces/{namespace}/deployments/{name}",
            "PATCH",
            path_params={"namespace": CONFIG.namespace, "name": "newsletter"},
            query_params=[("fieldManager", "acceptance-owner"), ("force", "true")],
            header_params={"Content-Type": "application/apply-patch+yaml"},
            body=drift,
            response_types_map={200: "object", 201: "object"},
            auth_settings=["BearerToken"],
            _return_http_data_only=True,
            _request_timeout=10,
        )
        for operation in (kube.dry_run, kube.apply):
            with self.assertRaises(DependencyUnavailable) as raised:
                operation(wanted)
            self.assertTrue(raised.exception.conflict)
        self.assertEqual(
            declared_view(kube.get("Deployment", "newsletter"), drift), drift
        )

        # Object preservation is proven; this cluster has no mounted-volume proof.
        retained = core.read_namespaced_secret("newsletter-settings", CONFIG.namespace)
        self.assertEqual(
            (retained.metadata.uid, retained.data), (secret.metadata.uid, secret.data)
        )
        retained_pvc = core.read_namespaced_persistent_volume_claim(
            "newsletter-data", CONFIG.namespace
        )
        self.assertEqual(retained_pvc.metadata.uid, pvc.metadata.uid)
        self.assertEqual(retained_pvc.spec.to_dict(), pvc.spec.to_dict())
        self.assertEqual(core.list_node().items, [])
