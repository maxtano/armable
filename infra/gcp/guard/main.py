"""Armable's spending guard.

Google Cloud sends this function a budget update several times a day. Two stages:

1. Spending reaches the cap:          stop the server. Its disk and data are kept; start it again when ready.
2. Spending reaches twice the cap:    unlink billing from the project, so nothing more can be charged.
   Google warns this shuts down everything in the project, so it is the last resort.
"""
import base64
import json
import os

import functions_framework

PROJECT = os.environ["PROJECT_ID"]
ZONE = os.environ["ZONE"]
INSTANCE = os.environ["INSTANCE"]


def decide(cost: float, budget: float) -> str:
    """What to do at this level of spending: nothing, stop the server, or stop billing."""
    if budget <= 0 or cost < budget:
        return "nothing"
    return "stop-billing" if cost >= 2 * budget else "stop-server"


def stop_server() -> None:
    from google.cloud import compute_v1
    client = compute_v1.InstancesClient()
    instance = client.get(project=PROJECT, zone=ZONE, instance=INSTANCE)
    if instance.status in ("TERMINATED", "STOPPING", "SUSPENDED"):
        print(f"{INSTANCE} is already {instance.status}")
        return
    client.stop(project=PROJECT, zone=ZONE, instance=INSTANCE)
    print(f"Stopped {INSTANCE}")


def stop_billing() -> None:
    from google.cloud import billing_v1
    client = billing_v1.CloudBillingClient()
    name = f"projects/{PROJECT}"
    if not client.get_project_billing_info(name=name).billing_enabled:
        print("Billing is already off")
        return
    client.update_project_billing_info(name=name, project_billing_info=billing_v1.ProjectBillingInfo(billing_account_name=""))
    print(f"Billing unlinked from {PROJECT}")


@functions_framework.cloud_event
def guard(cloud_event) -> None:
    message = json.loads(base64.b64decode(cloud_event.data["message"]["data"]).decode("utf-8"))
    cost, budget = float(message.get("costAmount", 0)), float(message.get("budgetAmount", 0))
    action = decide(cost, budget)
    print(f"Spent {cost:.2f} of {budget:.2f} {message.get('currencyCode', '')}: {action}")
    if action in ("stop-server", "stop-billing"):
        stop_server()
    if action == "stop-billing":
        stop_billing()
