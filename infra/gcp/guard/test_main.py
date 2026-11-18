"""Run with:  python -m pytest infra/gcp/guard  (or plain python test_main.py)."""
import base64, json, os, sys, types

os.environ.update(PROJECT_ID="p", ZONE="z", INSTANCE="armable")
sys.modules.setdefault("functions_framework", types.SimpleNamespace(cloud_event=lambda f: f))
import main  # noqa: E402


def event(cost, budget):
    data = base64.b64encode(json.dumps({"costAmount": cost, "budgetAmount": budget, "currencyCode": "USD"}).encode()).decode()
    return types.SimpleNamespace(data={"message": {"data": data}})


def test_decide():
    assert main.decide(0, 5) == "nothing"
    assert main.decide(4.99, 5) == "nothing"
    assert main.decide(5, 5) == "stop-server"
    assert main.decide(9.99, 5) == "stop-server"
    assert main.decide(10, 5) == "stop-billing"
    assert main.decide(3, 0) == "nothing"


def test_guard_calls_the_right_stops():
    calls = []
    main.stop_server, main.stop_billing = (lambda: calls.append("server")), (lambda: calls.append("billing"))
    main.guard(event(1, 5)); assert calls == []
    main.guard(event(6, 5)); assert calls == ["server"]
    calls.clear(); main.guard(event(12, 5)); assert calls == ["server", "billing"]


if __name__ == "__main__":
    test_decide(); test_guard_calls_the_right_stops(); print("guard tests passed")
