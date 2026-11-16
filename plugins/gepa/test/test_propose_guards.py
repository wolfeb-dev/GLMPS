import http.server
import json
import os
import subprocess
import sys
import threading
import time

import pytest

HERE = os.path.dirname(__file__)
PLUGIN_DIR = os.path.abspath(os.path.join(HERE, ".."))
VENDOR_DIR = os.path.join(PLUGIN_DIR, "vendor", "gepa")
sys.path.insert(0, PLUGIN_DIR)
sys.path.insert(0, VENDOR_DIR)
import propose_guards  # noqa: E402
from propose_guards import (  # noqa: E402
    DeadlineExceeded,
    _CallCounter,
    _validate_max_metric_calls,
    _validate_max_wall_seconds,
    make_evaluator,
    model_call,
    new_rules,
    parse_score,
    run,
)


def _one_failure():
    return [{"itemId": "i1", "code": "edit-without-read", "title": "Edited a file it never read", "body": "", "count": 1}]


def _base_input(**overrides):
    inp = {
        "modelUrl": "http://127.0.0.1:9",
        "models": {"fast": "haiku", "strong": "sonnet"},
        "maxMetricCalls": 5,
        "seedGuards": "- A.",
        "failures": _one_failure(),
    }
    inp.update(overrides)
    return inp


class _StubHandler(http.server.BaseHTTPRequestHandler):
    """Base handler; subclasses set class-level `status` / `body` bytes /
    `extra_headers`."""

    status = 200
    body = b"{}"
    extra_headers = {}

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        self.rfile.read(length)
        self.send_response(self.status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(self.body)))
        for key, value in self.extra_headers.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(self.body)

    def log_message(self, *_args):
        pass  # keep test output quiet


def _start_stub_server(handler_cls):
    server = http.server.HTTPServer(("127.0.0.1", 0), handler_cls)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def _stop_stub_server(server):
    server.shutdown()
    server.server_close()


def _judge_body(score=1, reason="ok"):
    return json.dumps({"choices": [{"message": {"content": json.dumps({"score": score, "reason": reason})}}]}).encode()


def _judge_ok_handler(score=1, reason="ok"):
    class Handler(_StubHandler):
        status = 200
        body = _judge_body(score, reason)

    return Handler


def _slow_judge_ok_handler(delay_seconds, score=1, reason="ok"):
    class Handler(_StubHandler):
        status = 200
        body = _judge_body(score, reason)

        def do_POST(self):
            time.sleep(delay_seconds)
            super().do_POST()

    return Handler


def _model_aware_handler(fail_for_model, fail_status=500, fail_body=b"route down"):
    """Answers a valid judge-shaped reply for every request EXCEPT ones whose
    JSON body's "model" field equals `fail_for_model`, which always get
    `fail_status`. Lets a test break only the strong (reflection) or only
    the fast (judge) role while the other keeps working."""

    class Handler(_StubHandler):
        def do_POST(self):
            length = int(self.headers.get("content-length", 0))
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw)
            except Exception:
                payload = {}
            if payload.get("model") == fail_for_model:
                self.send_response(fail_status)
                self.send_header("content-length", str(len(fail_body)))
                self.end_headers()
                self.wfile.write(fail_body)
                return
            body = _judge_body()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    return Handler


def _unparseable_for_model_handler(unparseable_for_model):
    """Like _model_aware_handler, but the targeted model gets a 200 whose
    content is plain prose (no JSON object at all) instead of an HTTP
    failure - a malformed reply, not a broken route."""

    class Handler(_StubHandler):
        def do_POST(self):
            length = int(self.headers.get("content-length", 0))
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw)
            except Exception:
                payload = {}
            content = "I cannot give a score here." if payload.get("model") == unparseable_for_model else json.dumps({"score": 1, "reason": "ok"})
            body = json.dumps({"choices": [{"message": {"content": content}}]}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    return Handler




def test_new_rules_only_returns_added_bullets():
    assert new_rules("- A.\n- B.", "- A.\n- B.\n- C.") == ["C."]


# C8 (final-fix-wave.md, MINOR): run() seeds optimize_anything with the
# literal placeholder "- (no guards yet)" when seedGuards is empty, but
# new_rules() is compared against the ORIGINAL (empty) seed - if the engine
# never touches that placeholder bullet, it must never be returned as if it
# were a genuinely new proposed rule.
def test_new_rules_never_returns_the_no_guards_yet_placeholder():
    assert new_rules("", "- (no guards yet)") == []
    assert new_rules("", "- (no guards yet)\n- Real rule.") == ["Real rule."]


def test_parse_score_clamped_and_tolerant():
    assert parse_score('{"score": 0.7, "reason": "x"}') == (0.7, "x")
    assert parse_score('{"score": 3}')[0] == 1.0
    assert parse_score("garbage")[0] == 0.0


# B7 (final-fix-wave.md, IMPORTANT): a malformed judge reply must not
# silently look like a real, verified score of 0.0 - on_failure lets the
# caller count real parse failures separately from real scores.
def test_parse_score_calls_on_failure_only_when_it_could_not_parse():
    calls = []
    assert parse_score('{"score": 0.5, "reason": "ok"}', on_failure=lambda: calls.append(1)) == (0.5, "ok")
    assert calls == []
    assert parse_score("no json here at all", on_failure=lambda: calls.append(1))[0] == 0.0
    assert calls == [1]
    assert parse_score("{broken json", on_failure=lambda: calls.append(1))[0] == 0.0
    assert calls == [1, 1]


@pytest.mark.filterwarnings("ignore:oa.log.* called outside of an evaluator function:UserWarning")
def test_make_evaluator_marks_parse_failures_counter_only_on_unparseable_output():
    from propose_guards import _ParseFailureCounter

    counter = _ParseFailureCounter()
    ev = make_evaluator(lambda p: "not json at all", parse_failures=counter)
    ev("- x", {"code": "c", "title": "t", "body": ""})
    assert counter.count == 1
    ev2 = make_evaluator(lambda p: '{"score": 1, "reason": "ok"}', parse_failures=counter)
    ev2("- x", {"code": "c", "title": "t", "body": ""})
    assert counter.count == 1, "a successful parse must not bump the counter"


@pytest.mark.filterwarnings("ignore:oa.log.* called outside of an evaluator function:UserWarning")
def test_evaluator_sends_candidate_and_failure_to_the_judge():
    # Calling make_evaluator()'s closure directly (rather than through gepa's
    # own EvaluatorWrapper) means oa.log() has no active log context; gepa
    # warns and discards the line in that case, which is expected and
    # harmless here (in a real run gepa always sets up that context first).
    seen = []
    ev = make_evaluator(lambda p: (seen.append(p), '{"score": 1, "reason": "ok"}')[1])
    assert ev("- Read files first.", {"code": "edit-without-read", "title": "Edited a file it never read", "body": ""}) == 1.0
    assert "- Read files first." in seen[0] and "Edited a file it never read" in seen[0]


def test_no_failures_is_a_clean_error():
    out = run({"modelUrl": "http://x", "models": {"fast": "haiku", "strong": "sonnet"}, "maxMetricCalls": 5, "seedGuards": "- A.", "failures": []})
    assert out["ok"] is False and out["newRules"] == []




def test_model_url_must_be_local_host():
    out = run(_base_input(modelUrl="http://evil.example.com:1234"))
    assert out["ok"] is False
    assert "127.0.0.1" in out["error"] or "localhost" in out["error"]
    assert out["newRules"] == []


def test_failures_missing_item_id_are_rejected_before_any_network_call():
    # modelUrl points at an unbound local port: if validation reached the
    # network at all, this would hang or refuse a connection rather than
    # returning promptly.
    out = run(_base_input(failures=[{"code": "c", "title": "t", "body": "b"}], modelUrl="http://127.0.0.1:9"))
    assert out["ok"] is False
    assert "itemId" in out["error"]


def test_failures_with_blank_item_id_are_rejected():
    out = run(_base_input(failures=[{"itemId": "   ", "code": "c", "title": "t", "body": "b"}]))
    assert out["ok"] is False
    assert "itemId" in out["error"]


def test_validate_max_metric_calls_rejects_non_positive_and_non_integer():
    for bad in (0, -1, 1.5, "5", True):
        value, err = _validate_max_metric_calls({"maxMetricCalls": bad})
        assert value is None, bad
        assert err and "maxMetricCalls" in err, bad


def test_validate_max_metric_calls_defaults_and_ceiling():
    assert _validate_max_metric_calls({}) == (propose_guards.DEFAULT_MAX_METRIC_CALLS, None)
    assert _validate_max_metric_calls({"maxMetricCalls": None}) == (propose_guards.DEFAULT_MAX_METRIC_CALLS, None)
    assert _validate_max_metric_calls({"maxMetricCalls": 200}) == (200, None)
    value, err = _validate_max_metric_calls({"maxMetricCalls": 201})
    assert value is None and "200" in err


def test_max_metric_calls_above_ceiling_is_rejected():
    out = run(_base_input(maxMetricCalls=201))
    assert out["ok"] is False
    assert "200" in out["error"]
    assert out["newRules"] == []


def test_max_metric_calls_zero_or_negative_or_non_integer_is_rejected_by_run():
    for bad in (0, -1, 1.5, "5"):
        out = run(_base_input(maxMetricCalls=bad))
        assert out["ok"] is False, bad
        assert "maxMetricCalls" in out["error"], bad


def test_validate_max_wall_seconds_defaults_ceiling_and_rejects_bad_values():
    assert _validate_max_wall_seconds({}) == (propose_guards.DEFAULT_MAX_WALL_SECONDS, None)
    assert _validate_max_wall_seconds({"maxWallSeconds": None}) == (propose_guards.DEFAULT_MAX_WALL_SECONDS, None)
    assert _validate_max_wall_seconds({"maxWallSeconds": 3600}) == (3600, None)
    value, err = _validate_max_wall_seconds({"maxWallSeconds": 3601})
    assert value is None and "3600" in err
    for bad in (0, -1, "60", True):
        value, err = _validate_max_wall_seconds({"maxWallSeconds": bad})
        assert value is None, bad
        assert err and "maxWallSeconds" in err, bad


def test_max_metric_calls_at_ceiling_is_allowed_through_to_engine():
    import gepa.optimize_anything as oa_mod

    captured = {}

    class FakeResult:
        best_candidate = "- A.\n- B."
        total_metric_calls = 4

    def fake_optimize_anything(**kwargs):
        captured["config"] = kwargs["config"]
        return FakeResult()

    original = oa_mod.optimize_anything
    oa_mod.optimize_anything = fake_optimize_anything
    try:
        out = run(_base_input(maxMetricCalls=200))
    finally:
        oa_mod.optimize_anything = original

    assert out["ok"] is True
    assert captured["config"].engine.max_metric_calls == 200
    # fix round 1, item 2: bounds candidate proposals too, so a fully broken
    # reflection route can't spin the engine forever (see
    # test_reflection_totally_broken_is_reported_as_ok_false_with_counts).
    assert captured["config"].engine.max_candidate_proposals == 200


def test_default_max_metric_calls_is_forty_when_omitted():
    import gepa.optimize_anything as oa_mod

    inp = _base_input()
    del inp["maxMetricCalls"]
    captured = {}

    class FakeResult:
        best_candidate = "- A."
        total_metric_calls = 1

    def fake_optimize_anything(**kwargs):
        captured["config"] = kwargs["config"]
        return FakeResult()

    original = oa_mod.optimize_anything
    oa_mod.optimize_anything = fake_optimize_anything
    try:
        run(inp)
    finally:
        oa_mod.optimize_anything = original

    assert captured["config"].engine.max_metric_calls == 40


def test_tracking_default_does_not_crash_the_engine():
    # gepa 0.1.4's optimize_anything dereferences config.tracking.logger
    # unconditionally; GEPAConfig(tracking=None) raises AttributeError deep
    # inside the engine. run() must leave tracking at its dataclass default
    # (a real TrackingConfig instance) rather than passing None.
    import gepa.optimize_anything as oa_mod

    captured = {}

    class FakeResult:
        best_candidate = "- A."
        total_metric_calls = 1

    def fake_optimize_anything(**kwargs):
        captured["config"] = kwargs["config"]
        return FakeResult()

    original = oa_mod.optimize_anything
    oa_mod.optimize_anything = fake_optimize_anything
    try:
        run(_base_input())
    finally:
        oa_mod.optimize_anything = original

    assert captured["config"].tracking is not None
    assert captured["config"].tracking.logger is None


# model_call: raises rather than swallowing, and never leaves the host
# named in modelUrl even via a redirect (fix round 1, item 1) ---


def test_model_call_raises_on_http_error():
    server = _start_stub_server(type("H", (_StubHandler,), {"status": 500, "body": b"boom"}))
    try:
        call = model_call(f"http://127.0.0.1:{server.server_port}", "haiku")
        with pytest.raises(Exception):
            call("hi")
    finally:
        _stop_stub_server(server)


def test_model_call_raises_on_unparseable_response():
    server = _start_stub_server(type("H", (_StubHandler,), {"status": 200, "body": b"not json"}))
    try:
        call = model_call(f"http://127.0.0.1:{server.server_port}", "haiku")
        with pytest.raises(Exception):
            call("hi")
    finally:
        _stop_stub_server(server)


def test_model_call_refuses_to_follow_a_redirect_to_another_local_port():
    target_hits = []

    class TargetHandler(_StubHandler):
        status = 200
        body = json.dumps({"choices": [{"message": {"content": "should never be read"}}]}).encode()

        def do_POST(self):
            target_hits.append(self.path)
            super().do_POST()

    target = _start_stub_server(TargetHandler)
    try:

        class RedirectHandler(_StubHandler):
            status = 302
            body = b""
            extra_headers = {"Location": f"http://127.0.0.1:{target.server_port}/chat/completions"}

        redirector = _start_stub_server(RedirectHandler)
        try:
            call = model_call(f"http://127.0.0.1:{redirector.server_port}", "haiku")
            with pytest.raises(Exception):
                call("hi")
        finally:
            _stop_stub_server(redirector)
    finally:
        _stop_stub_server(target)

    assert target_hits == [], "the redirect target must never receive the request"


def test_model_call_never_proxies_even_when_http_proxy_is_set(monkeypatch):
    # B6 (final-fix-wave.md, IMPORTANT): build_opener()'s default handler set
    # includes a ProxyHandler that reads HTTP_PROXY/HTTPS_PROXY from the
    # environment - unmapped, a proxy env var set on the box running the
    # server would send every judge/reflection prompt through it, off the
    # machine entirely. model_call() builds its opener fresh on every call
    # (not a module-level constant built once at import time), so setting
    # the env var via monkeypatch (auto-restored after the test) is enough -
    # no module reload needed.
    proxy_hits = []

    class ProxyHandler(_StubHandler):
        status = 200
        body = json.dumps({"choices": [{"message": {"content": "should never be read"}}]}).encode()

        def do_POST(self):
            proxy_hits.append(self.path)
            super().do_POST()

    proxy = _start_stub_server(ProxyHandler)
    target = _start_stub_server(_judge_ok_handler())
    try:
        monkeypatch.setenv("HTTP_PROXY", f"http://127.0.0.1:{proxy.server_port}")
        monkeypatch.setenv("http_proxy", f"http://127.0.0.1:{proxy.server_port}")
        call = model_call(f"http://127.0.0.1:{target.server_port}", "haiku")
        content = call("hi")
        assert content, "the direct target must still answer normally"
    finally:
        _stop_stub_server(proxy)
        _stop_stub_server(target)
    assert proxy_hits == [], "the proxy must never receive the request, even with HTTP_PROXY set"


# _CallCounter: attempt/failure counting and deadline enforcement in
# isolation, deterministic (no network, no real elapsed time) (fix round 1,
# items 3 and 4) ---


def test_call_counter_counts_a_successful_call():
    counter = _CallCounter(lambda p: "reply:" + p, deadline_at=time.monotonic() + 1000)
    assert counter("hi") == "reply:hi"
    assert counter.attempts == 1
    assert counter.failures == 0


def test_call_counter_counts_a_failed_call_and_reraises():
    def boom(_p):
        raise RuntimeError("boom")

    counter = _CallCounter(boom, deadline_at=time.monotonic() + 1000)
    with pytest.raises(RuntimeError):
        counter("hi")
    assert counter.attempts == 1
    assert counter.failures == 1


def test_call_counter_raises_deadline_exceeded_without_calling_inner_once_past_deadline():
    inner_calls = []

    def inner(p):
        inner_calls.append(p)
        return "reply"

    counter = _CallCounter(inner, deadline_at=time.monotonic() - 1)  # already expired
    with pytest.raises(DeadlineExceeded):
        counter("hi")
    assert counter.attempts == 1
    assert counter.failures == 1
    assert inner_calls == [], "a call past the deadline must never reach the network"




def test_full_round_trip_against_a_local_stub_server_honours_the_ceiling():
    # The input shape has one modelUrl shared by both the fast (judge) and
    # strong (reflection) roles, so one stub server answers every call. Its
    # fixed judge-shaped JSON body also works as a (degenerate) reflection
    # reply: gepa's ``` extractor falls back to the raw stripped text when no
    # fenced block is present, so the run completes without needing two
    # different stub responses.
    server = _start_stub_server(_judge_ok_handler())
    try:
        inp = _base_input(modelUrl=f"http://127.0.0.1:{server.server_port}", maxMetricCalls=2)
        out = run(inp)
    finally:
        _stop_stub_server(server)
    assert out["ok"] is True
    assert out["error"] is None
    assert isinstance(out["metricCalls"], int)
    assert isinstance(out["reflectionCalls"], int)
    assert out["reflectionFailures"] == 0
    assert out["sourceItemIds"] == ["i1"]


def test_run_reports_ok_false_with_true_call_counts_when_evaluator_http_call_fails():
    # fix round 1, item 3: previously this propagated a bare exception out
    # of run() with no way to recover how many calls had actually happened;
    # run() now catches it itself (it is the only place holding the
    # counters) and reports the true count instead of 0.
    server = _start_stub_server(type("H", (_StubHandler,), {"status": 500, "body": b"boom"}))
    try:
        inp = _base_input(modelUrl=f"http://127.0.0.1:{server.server_port}", maxMetricCalls=3)
        out = run(inp)
    finally:
        _stop_stub_server(server)
    assert out["ok"] is False
    assert out["error"]
    assert out["metricCalls"] >= 1


def test_reflection_totally_broken_is_reported_as_ok_false_with_counts():
    # fix round 1, item 2: gepa's vendored reflective_mutation proposer
    # swallows every reflection (strong model) exception internally and
    # simply proposes nothing that iteration; left alone this looks
    # identical to a healthy (if unproductive) run. run() must notice every
    # attempted reflection call failed and report ok:false instead.
    server = _start_stub_server(_model_aware_handler(fail_for_model="sonnet"))
    try:
        inp = _base_input(modelUrl=f"http://127.0.0.1:{server.server_port}", maxMetricCalls=5)
        out = run(inp)
    finally:
        _stop_stub_server(server)
    assert out["ok"] is False
    assert out["reflectionCalls"] > 0
    assert out["reflectionFailures"] == out["reflectionCalls"]
    assert out["metricCalls"] > 0  # the judge/fast role kept working throughout
    assert "reflection" in out["error"].lower()


def _fail_first_judge_call_handler():
    state = {"haiku_calls": 0}

    class Handler(_StubHandler):
        def do_POST(self):
            length = int(self.headers.get("content-length", 0))
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw)
            except Exception:
                payload = {}
            if payload.get("model") == "haiku":
                state["haiku_calls"] += 1
                content = "no idea, sorry" if state["haiku_calls"] == 1 else json.dumps({"score": 1, "reason": "ok"})
            else:
                content = json.dumps({"score": 1, "reason": "ok"})
            body = json.dumps({"choices": [{"message": {"content": content}}]}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    return Handler, state


def test_run_reports_ok_false_when_every_judge_call_is_unparseable():
    # B7 (final-fix-wave.md, IMPORTANT): a run where the judge role only ever
    # returned prose (no JSON object at all) must not look like a healthy,
    # if unproductive, run - every "score" it produced was never actually
    # verified against anything the judge said.
    server = _start_stub_server(_unparseable_for_model_handler(unparseable_for_model="haiku"))
    try:
        inp = _base_input(modelUrl=f"http://127.0.0.1:{server.server_port}", maxMetricCalls=3)
        out = run(inp)
    finally:
        _stop_stub_server(server)
    assert out["ok"] is False
    assert out["metricCalls"] > 0
    assert out["judgeParseFailures"] == out["metricCalls"]
    assert "judge" in out["error"].lower()
    assert "unparseable" in out["error"].lower()


def test_run_reports_judgeParseFailures_when_only_some_judge_calls_are_unparseable():
    # B7: a run that is MOSTLY healthy but hit one malformed judge reply
    # along the way must still complete normally (ok:true) - the garbage
    # reply is reported via judgeParseFailures, not hidden as a real 0 score
    # and not treated as a total loss of trust in the run either.
    handler, _state = _fail_first_judge_call_handler()
    server = _start_stub_server(handler)
    try:
        inp = _base_input(modelUrl=f"http://127.0.0.1:{server.server_port}", maxMetricCalls=5)
        out = run(inp)
    finally:
        _stop_stub_server(server)
    assert out["metricCalls"] >= 2, "need at least 2 judge calls to prove a PARTIAL failure"
    assert 0 < out["judgeParseFailures"] < out["metricCalls"]
    assert out["ok"] is True


def test_max_wall_seconds_deadline_aborts_a_slow_running_optimization():
    # fix round 1, item 4: a modelUrl that responds slowly (or a network
    # that stalls) must not run unbounded; once the wall-clock budget is
    # spent the next model call is refused rather than attempted.
    server = _start_stub_server(_slow_judge_ok_handler(delay_seconds=0.3))
    try:
        inp = _base_input(modelUrl=f"http://127.0.0.1:{server.server_port}", maxMetricCalls=10, maxWallSeconds=0.05)
        started = time.monotonic()
        out = run(inp)
        elapsed = time.monotonic() - started
    finally:
        _stop_stub_server(server)
    assert out["ok"] is False
    assert (out["error"] or "") != ""
    lowered = out["error"].lower()
    deadline_evidence = "deadline" in lowered or "wallseconds" in lowered or "wall seconds" in lowered
    assert deadline_evidence, out["error"]
    assert out["metricCalls"] + out["reflectionCalls"] >= 1
    # The run must not abort before its own 0.05s budget is spent (at least
    # one call was attempted, asserted above). A tighter floor tied to the
    # stub's 0.3s sleep flaked on the Windows CI runner (0.156s observed),
    # so this checks only the budget itself.
    assert elapsed >= 0.05


def test_cli_writes_ok_false_output_file_when_model_is_unreachable():
    import tempfile

    server = _start_stub_server(type("H", (_StubHandler,), {"status": 500, "body": b"boom"}))
    try:
        with tempfile.TemporaryDirectory() as tmp:
            in_path = os.path.join(tmp, "in.json")
            out_path = os.path.join(tmp, "out.json")
            inp = _base_input(modelUrl=f"http://127.0.0.1:{server.server_port}", maxMetricCalls=3)
            with open(in_path, "w", encoding="utf-8") as f:
                json.dump(inp, f)
            script = os.path.join(PLUGIN_DIR, "propose_guards.py")
            env = dict(os.environ)
            env["PYTHONPATH"] = VENDOR_DIR
            subprocess.run(
                [sys.executable, script, "--in", in_path, "--out", out_path],
                env=env,
                timeout=60,
                capture_output=True,
                text=True,
            )
            assert os.path.exists(out_path), "propose_guards.py must always write an output file"
            with open(out_path, encoding="utf-8") as f:
                out = json.load(f)
            assert out["ok"] is False
            assert out["error"]
            assert out["metricCalls"] >= 1
            assert isinstance(out["reflectionCalls"], int)
            assert isinstance(out["reflectionFailures"], int)
    finally:
        _stop_stub_server(server)


def test_propose_guards_imports_with_only_vendor_dir_on_pythonpath():
    # -S disables the `site` module (so any site-packages directory never
    # reaches sys.path); combined with PYTHONPATH pointing solely at the
    # vendored gepa copy, a successful import proves the whole chain
    # (propose_guards.py -> gepa.optimize_anything) needs nothing beyond the
    # standard library and the vendored source.
    env = dict(os.environ)
    env["PYTHONPATH"] = VENDOR_DIR
    code = (
        f"import sys; sys.path.insert(0, {PLUGIN_DIR!r}); "
        "import propose_guards; "
        "import gepa.optimize_anything; "
        "print('ISOLATED_IMPORT_OK')"
    )
    result = subprocess.run(
        [sys.executable, "-S", "-c", code],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert "ISOLATED_IMPORT_OK" in result.stdout




@pytest.mark.parametrize(
    "url",
    [
        "file://localhost/etc/passwd",
        "file://127.0.0.1/etc/passwd",
        "ftp://127.0.0.1/model",
        "gopher://localhost/x",
        "127.0.0.1:8123/v1",
        "//127.0.0.1/v1",
        "",
    ],
)
def test_assert_local_model_url_requires_http_or_https(url):
    with pytest.raises(ValueError):
        propose_guards.assert_local_model_url(url)


@pytest.mark.parametrize("url", ["http://127.0.0.1:8123/v1", "https://localhost/v1", "HTTP://LOCALHOST:1/x"])
def test_assert_local_model_url_accepts_local_http_and_https(url):
    propose_guards.assert_local_model_url(url)


def test_run_rejects_a_file_scheme_model_url_before_any_call():
    out = run(_base_input(modelUrl="file://localhost/etc/passwd"))
    assert out["ok"] is False and out["newRules"] == []


def test_local_only_opener_has_no_file_or_ftp_handlers():
    import urllib.request

    opener = propose_guards._build_local_only_opener()
    kinds = [type(h) for h in opener.handlers]
    assert urllib.request.FileHandler not in kinds
    assert urllib.request.FTPHandler not in kinds
    assert urllib.request.DataHandler not in kinds
    for h in opener.handlers:
        assert not hasattr(h, "file_open") and not hasattr(h, "ftp_open") and not hasattr(h, "data_open")


def test_local_only_opener_refuses_a_file_url():
    import urllib.error

    opener = propose_guards._build_local_only_opener()
    with pytest.raises(urllib.error.URLError):
        opener.open("file:///etc/passwd")


def test_evaluator_logs_an_oa_log_failure_to_stderr_instead_of_passing_silently(monkeypatch, capsys):
    import gepa.optimize_anything as oa

    def boom(_msg):
        raise RuntimeError("log sink exploded")

    monkeypatch.setattr(oa, "log", boom)
    ev = make_evaluator(lambda p: '{"score": 1, "reason": "ok"}')
    assert ev("- x", {"code": "c", "title": "t", "body": ""}) == 1.0, "a logging failure must not change the score"
    assert "log sink exploded" in capsys.readouterr().err
