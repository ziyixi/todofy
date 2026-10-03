"""Public bootstrap invariants; no host, cluster, credential or production access."""

import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
BOOTSTRAP = ROOT / "k3s" / "bootstrap"


def documents(name):
    return tuple(yaml.safe_load_all((BOOTSTRAP / name).read_text()))


class BootstrapBoundaries(unittest.TestCase):
    def test_observer_termination_metadata_never_falls_back_to_logs(self):
        resource = yaml.safe_load((ROOT / "k3s/newsletter/observer.yaml").read_text())
        pod = resource["spec"]["jobTemplate"]["spec"]["template"]["spec"]
        for container in [*pod["initContainers"], *pod["containers"]]:
            self.assertEqual(
                container["terminationMessagePath"], "/dev/termination-log"
            )
            self.assertEqual(container["terminationMessagePolicy"], "File")

    def test_controller_writes_only_supported_namespace_resources(self):
        roles = {
            item["metadata"]["name"]: item
            for item in documents("rbac.yaml")
            if item["kind"] == "Role"
        }
        controller = roles["platform-controller"]
        self.assertEqual(controller["metadata"]["namespace"], "personal-cloud")
        allowed = {
            ("apps", "deployments"),
            ("batch", "cronjobs"),
            ("", "services"),
            ("", "configmaps"),
            ("", "pods"),
        }
        actual = set()
        for rule in controller["rules"]:
            self.assertNotIn("nonResourceURLs", rule)
            for group in rule["apiGroups"]:
                for resource in rule["resources"]:
                    actual.add((group, resource))
                    verbs = (
                        {"get", "list"}
                        if resource == "pods"
                        else {
                            "get",
                            "list",
                            "create",
                            "patch",
                            "update",
                        }
                    )
                    self.assertEqual(set(rule["verbs"]), verbs)
        self.assertEqual(actual, allowed)
        bindings = [
            item
            for item in documents("rbac.yaml")
            if item["kind"] in {"RoleBinding", "ClusterRoleBinding"}
        ]
        controller_bindings = [
            item
            for item in bindings
            if any(
                subject["name"] == "platform-controller" for subject in item["subjects"]
            )
        ]
        self.assertEqual(len(controller_bindings), 1)
        self.assertEqual(controller_bindings[0]["kind"], "RoleBinding")
        self.assertEqual(
            controller_bindings[0]["roleRef"]["name"], "platform-controller"
        )

    def test_observer_is_readonly_with_nodes_as_its_only_cluster_permission(self):
        resources = documents("rbac.yaml")
        observer = next(
            item
            for item in resources
            if item["kind"] == "Role"
            and item["metadata"]["name"] == "platform-observer"
        )
        observed = set()
        for rule in observer["rules"]:
            self.assertEqual(set(rule["verbs"]), {"get", "list"})
            observed.update(rule["resources"])
        self.assertEqual(observed, {"pods", "deployments"})
        cluster = [item for item in resources if item["kind"] == "ClusterRole"]
        self.assertEqual(len(cluster), 1)
        self.assertEqual(
            cluster[0]["rules"],
            [
                {
                    "apiGroups": [""],
                    "resources": ["nodes"],
                    "verbs": ["get", "list"],
                }
            ],
        )
        binding = next(
            item for item in resources if item["kind"] == "ClusterRoleBinding"
        )
        self.assertEqual(
            binding["subjects"],
            [
                {
                    "kind": "ServiceAccount",
                    "name": "platform-observer",
                    "namespace": "personal-cloud",
                }
            ],
        )

    def test_observer_has_no_long_lived_host_token(self):
        self.assertFalse((BOOTSTRAP / "observer-credential.yaml").exists())
        account = next(
            item
            for item in documents("rbac.yaml")
            if item["kind"] == "ServiceAccount"
            and item["metadata"]["name"] == "platform-observer"
        )
        self.assertFalse(account["automountServiceAccountToken"])

    def test_static_volumes_retain_exact_preexisting_state(self):
        values = documents("storage.yaml")
        volumes = {
            item["metadata"]["name"]: item
            for item in values
            if item["kind"] == "PersistentVolume"
        }
        claims = {
            item["metadata"]["name"]: item
            for item in values
            if item["kind"] == "PersistentVolumeClaim"
        }
        expected = {
            "platform-state": "platform",
            "observer-state": "observer",
            "newsletter-data": "newsletter/data",
            "newsletter-auth": "newsletter/auth",
            "newsletter-config": "newsletter/config",
        }
        self.assertEqual(set(claims), set(expected))
        self.assertEqual(len(volumes), 5)
        for name, directory in expected.items():
            claim = claims[name]
            volume = volumes[claim["spec"]["volumeName"]]
            self.assertEqual(claim["metadata"]["namespace"], "personal-cloud")
            self.assertEqual(claim["spec"]["storageClassName"], "")
            spec = volume["spec"]
            self.assertEqual(spec["persistentVolumeReclaimPolicy"], "Retain")
            self.assertEqual(spec["storageClassName"], "")
            self.assertEqual(
                spec["claimRef"], {"name": name, "namespace": "personal-cloud"}
            )
            self.assertEqual(
                spec["hostPath"],
                {"path": "/srv/todofy/" + directory, "type": "Directory"},
            )
            self.assertEqual(spec["accessModes"], ["ReadWriteOnce"])

    def test_observer_cronjob_uses_image_and_only_fixed_nonroot_metadata_mounts(self):
        values = tuple(
            yaml.safe_load_all((ROOT / "k3s/newsletter/observer.yaml").read_text())
        )
        self.assertEqual(len(values), 1)
        workload = values[0]
        self.assertEqual(workload["kind"], "CronJob")
        self.assertEqual(workload["spec"]["schedule"], "*/5 * * * *")
        self.assertEqual(workload["spec"]["concurrencyPolicy"], "Forbid")
        self.assertFalse(workload["spec"]["suspend"])
        pod = workload["spec"]["jobTemplate"]["spec"]["template"]["spec"]
        self.assertEqual(pod["serviceAccountName"], "platform-observer")
        self.assertFalse(pod["automountServiceAccountToken"])
        self.assertEqual(pod["securityContext"]["runAsUser"], 10001)
        self.assertEqual(pod["securityContext"]["runAsGroup"], 10001)
        self.assertEqual(pod["securityContext"]["fsGroup"], 10001)
        self.assertTrue(pod["securityContext"]["runAsNonRoot"])
        self.assertNotIn("hostPID", pod)
        self.assertNotIn("hostNetwork", pod)
        container = pod["containers"][0]
        self.assertEqual(container["args"], ["observer"])
        self.assertEqual(container["securityContext"]["capabilities"]["drop"], ["ALL"])
        self.assertFalse(container["securityContext"]["allowPrivilegeEscalation"])
        self.assertTrue(container["securityContext"]["readOnlyRootFilesystem"])
        volumes = {item["name"]: item for item in pod["volumes"]}
        self.assertEqual(
            volumes["system-bus"]["hostPath"],
            {"path": "/run/dbus/system_bus_socket", "type": "Socket"},
        )
        self.assertEqual(
            volumes["meminfo"]["hostPath"], {"path": "/proc/meminfo", "type": "File"}
        )
        for mount in container["volumeMounts"]:
            if mount["name"] != "state":
                self.assertTrue(mount["readOnly"])
        self.assertEqual(
            volumes["state"]["persistentVolumeClaim"]["claimName"], "observer-state"
        )
        main_mounts = {item["name"]: item for item in container["volumeMounts"]}
        self.assertNotIn("system-bus", main_mounts)
        self.assertEqual(
            main_mounts["systemd-snapshot"]["mountPath"], "/run/observer-systemd"
        )
        self.assertTrue(main_mounts["systemd-snapshot"]["readOnly"])
        self.assertEqual(
            main_mounts["kubernetes-api"]["mountPath"],
            "/var/run/secrets/kubernetes.io/serviceaccount",
        )
        self.assertTrue(main_mounts["kubernetes-api"]["readOnly"])
        self.assertEqual(
            volumes["systemd-snapshot"]["emptyDir"],
            {"medium": "Memory", "sizeLimit": "64Ki"},
        )
        self.assertFalse((ROOT / "systemd/todofy-fleet.service").exists())
        self.assertFalse((ROOT / "systemd/todofy-fleet.timer").exists())

    def test_systemd_init_cannot_access_observer_identity_secrets_or_persistent_state(
        self,
    ):
        workload = next(
            yaml.safe_load_all((ROOT / "k3s/newsletter/observer.yaml").read_text())
        )
        pod = workload["spec"]["jobTemplate"]["spec"]["template"]["spec"]
        self.assertEqual(len(pod["initContainers"]), 1)
        init = pod["initContainers"][0]
        self.assertEqual(init["image"], pod["containers"][0]["image"])
        self.assertEqual(init["args"], ["observer-systemd"])
        self.assertNotIn("env", init)
        self.assertNotIn("envFrom", init)
        self.assertEqual(
            init["securityContext"],
            {
                "runAsNonRoot": True,
                "runAsUser": 65534,
                "runAsGroup": 10001,
                "allowPrivilegeEscalation": False,
                "readOnlyRootFilesystem": True,
                "capabilities": {"drop": ["ALL"]},
            },
        )
        self.assertEqual(
            init["resources"],
            {
                "requests": {"cpu": "25m", "memory": "32Mi"},
                "limits": {"cpu": "250m", "memory": "64Mi"},
            },
        )
        mounts = {item["name"]: item for item in init["volumeMounts"]}
        self.assertEqual(set(mounts), {"system-bus", "systemd-snapshot"})
        self.assertTrue(mounts["system-bus"]["readOnly"])
        self.assertNotIn("readOnly", mounts["systemd-snapshot"])
        self.assertEqual(
            mounts["systemd-snapshot"]["mountPath"], "/run/observer-systemd"
        )

    def test_rotating_api_identity_is_projected_only_into_main_observer(self):
        workload = next(
            yaml.safe_load_all((ROOT / "k3s/newsletter/observer.yaml").read_text())
        )
        pod = workload["spec"]["jobTemplate"]["spec"]["template"]["spec"]
        self.assertFalse(pod["automountServiceAccountToken"])
        volume = next(
            item for item in pod["volumes"] if item["name"] == "kubernetes-api"
        )
        self.assertEqual(
            volume["projected"]["sources"],
            [
                {"serviceAccountToken": {"path": "token", "expirationSeconds": 3600}},
                {
                    "configMap": {
                        "name": "kube-root-ca.crt",
                        "items": [{"key": "ca.crt", "path": "ca.crt"}],
                    }
                },
                {
                    "downwardAPI": {
                        "items": [
                            {
                                "path": "namespace",
                                "fieldRef": {"fieldPath": "metadata.namespace"},
                            }
                        ]
                    }
                },
            ],
        )
        for init in pod["initContainers"]:
            self.assertNotIn(
                "kubernetes-api", {item["name"] for item in init["volumeMounts"]}
            )
        self.assertEqual(
            {item["name"] for item in pod["containers"][0]["volumeMounts"]},
            {"state", "systemd-snapshot", "kubernetes-api", "meminfo"},
        )
