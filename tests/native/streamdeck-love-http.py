"""Check the real bridge without a Spotify account or library writes.

Run: python3 tests/native/streamdeck-love-http.py /path/to/compiled/mini
"""

import json
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

with tempfile.TemporaryDirectory(prefix="streamdeck-love-http-") as directory:
    path = pathlib.Path(directory) / "config.json"
    token = "b" * 64
    valid = {"port": 47685, "token": token, "visible": False}
    invalid = [None, [], {}, {**valid, "token": token + "\n"}]
    invalid += [{**valid, "port": port} for port in (True, 1023, 65536, 47685.5, "47685")]
    invalid += [{**valid, "keys": keys} for keys in (None, "mhlpr", ["m", "m", "l", "p", "r"])]
    invalid += [
        {**valid, "modifiers": mods} for mods in (True, None, "6400", 6400.5, -1, 2**32 + 6400)
    ]
    for config, expected in [
        (valid, 0),
        ({**valid, "keys": ["m", "h", "l", "p"]}, 0),
        *[(config, 1) for config in invalid],
    ]:
        path.write_text(json.dumps(config))
        check = subprocess.run(
            [sys.argv[1], "--validate-config", str(path)], capture_output=True, text=True
        )
        assert check.returncode == expected, check.stderr
    path.write_text(json.dumps({"port": 47685, "token": token, "visible": False}))
    process = subprocess.Popen(
        [sys.argv[1], str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE
    )

    def request(route, body=None, auth=True, origin=None, method=None):
        headers = {"Content-Type": "application/json"}
        if auth:
            headers["Authorization"] = "Bearer " + token
        if origin:
            headers["Origin"] = origin
        req = urllib.request.Request(
            "http://127.0.0.1:47685" + route,
            data=json.dumps(body).encode() if body is not None else None,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=4) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    try:
        for _ in range(40):
            try:
                status, data = request("/love")
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise AssertionError("test companion did not start")
        assert status == 200 and not data["connected"]
        assert request("/love", auth=False)[0] == 401
        assert request("/love", origin="https://malicious.example")[0] == 403
        state = {
            "uri": "spotify:track:test",
            "account": "test",
            "supported": True,
            "loved": False,
            "liked": False,
        }
        assert request("/sync", {"state": state, "results": []})[0] == 200
        body = {key: state[key] for key in ["uri", "account", "loved"]}
        body["action"] = "love"
        assert request("/love", body, auth=False)[0] == 401
        status, accepted = request("/love", body)
        assert status == 202
        assert request("/love", body)[0] == 409
        _, sync = request("/sync", {"state": state, "results": []})
        assert len(sync["commands"]) == 1
        command = sync["commands"][0]
        assert (
            command["action"] == "love"
            and command["value"] is True
            and command["id"] == accepted["id"]
        )
        state.update(loved=True, liked=True)
        result = {"id": accepted["id"], "ok": True}
        request("/sync", {"state": state, "results": [result]})
        _, data = request("/love")
        assert data["state"]["loved"] and not data["busy"] and data["results"] == [result]
        assert request("/love", body)[0] == 409
        assert request("/love", {**body, "uri": "spotify:track:other", "loved": True})[0] == 409
        assert request("/love", method="DELETE")[0] == 405
        assert not request("/status")[1]["visible"]
        for action in ["like", "add"]:
            body = {"action": action, "uri": state["uri"], "account": state["account"]}
            if action == "like":
                body["liked"] = True
                assert request("/love", {**body, "liked": 1})[0] == 400
                assert request("/love", {**body, "liked": False})[0] == 409
            assert request("/love", {**body, "uri": "spotify:track:other"})[0] == 409
            status, accepted = request("/love", body)
            assert status == 202
            assert request("/love", body)[0] == 409
            _, sync = request("/sync", {"state": state, "results": []})
            assert len(sync["commands"]) == 1 and sync["commands"][0]["action"] == action
            if action == "like":
                assert sync["commands"][0]["value"] is False
                state.update(liked=False, loved=False)
            request("/sync", {"state": state, "results": [{"id": accepted["id"], "ok": True}]})
        state["shuffle"] = False
        request("/sync", {"state": state, "results": []})
        for action in ["seek-forward", "queue-toggle", "shuffle", "randomize"]:
            body = {"action": action, "uri": state["uri"], "account": state["account"]}
            if action == "shuffle":
                body["shuffle"] = False
                assert request("/love", {**body, "shuffle": 0})[0] == 400
                assert request("/love", {**body, "shuffle": True})[0] == 409
            assert request("/love", {**body, "account": "other"})[0] == 409
            status, accepted = request("/love", body)
            assert status == 202
            assert request("/love", body)[0] == 409
            _, sync = request("/sync", {"state": state, "results": []})
            assert len(sync["commands"]) == 1 and sync["commands"][0]["action"] == action
            if action == "shuffle":
                assert sync["commands"][0]["value"] is True
                state["shuffle"] = True
            request("/sync", {"state": state, "results": [{"id": accepted["id"], "ok": True}]})
        state["playlistSelector"] = {
            "ready": True,
            "playlists": [{"uri": "spotify:playlist:one", "name": "First", "saved": False}],
        }
        request("/sync", {"state": state, "results": []})
        assert request("/love")[1]["state"]["playlistSelector"] == state["playlistSelector"]
        body = {
            "action": "playlist",
            "uri": state["uri"],
            "account": state["account"],
            "playlist": "spotify:playlist:one",
            "saved": False,
        }
        for field, value, status in [
            ("playlist", "bad", 400),
            ("saved", 0, 400),
            ("saved", True, 409),
            ("uri", "spotify:track:other", 409),
            ("account", "other", 409),
            ("playlist", "spotify:playlist:missing", 409),
        ]:
            assert request("/love", {**body, field: value})[0] == status
        status, accepted = request("/love", body)
        assert status == 202
        assert request("/love", body)[0] == 409
        _, sync = request("/sync", {"state": state, "results": []})
        assert sync["commands"][0]["playlist"] == body["playlist"]
        assert sync["commands"][0]["saved"] is False
        assert sync["commands"][0]["action"] == "playlist"
        state["playlistSelector"]["playlists"][0]["saved"] = True
        request("/sync", {"state": state, "results": [{"id": accepted["id"], "ok": True}]})
        assert request("/love")[1]["state"]["playlistSelector"]["playlists"][0]["saved"] is True
        assert (
            request("/seek", {"uri": state["uri"], "account": state["account"], "position": 1000})[
                0
            ]
            == 503
        )
        state.update(canSeek=True, position=5000, duration=60000)
        request("/sync", {"state": state, "results": []})
        seek_body = {"uri": state["uri"], "account": state["account"], "position": 1000}
        assert request("/seek", seek_body, auth=False)[0] == 401
        assert request("/seek", seek_body, origin="https://malicious.example")[0] == 403
        for position in [True, "1000", -1, None]:
            assert request("/seek", {**seek_body, "position": position})[0] == 400
        for patch in [{"uri": "spotify:track:other"}, {"account": "other"}, {"position": 60000}]:
            assert request("/seek", {**seek_body, **patch})[0] == 409
        assert request("/seek", method="DELETE")[0] == 405
        assert request("/seek", {**seek_body, "position": 12000})[0] == 202
        assert request("/seek", {**seek_body, "position": 6000})[0] == 202
        _, direct = request("/seek")
        assert len(direct["commands"]) == 1 and direct["commands"][0]["position"] == 6000
        assert not request("/sync", {"state": state, "results": []})[1]["commands"]
        assert request("/seek", seek_body)[0] == 202
        state["uri"] = "spotify:track:next"
        request("/sync", {"state": state, "results": []})
        assert request("/seek")[1]["commands"] == [], "track changes discard undelivered seeks"
        seek_body["uri"] = state["uri"]
        latencies = []
        with ThreadPoolExecutor(max_workers=1) as executor:
            for position in [12000, 3000, 0, 20000, 7000]:
                waiting = executor.submit(request, "/seek", origin="https://xpui.app.spotify.com")
                time.sleep(0.025)
                started = time.perf_counter()
                assert request("/seek", {**seek_body, "position": position})[0] == 202
                _, direct = waiting.result(timeout=1)
                latencies.append((time.perf_counter() - started) * 1000)
                assert direct["commands"][0]["position"] == position
        assert max(latencies) < 200, f"seek commands waited too long: {latencies}"
        print(
            f"Direct seek delivery: median {sorted(latencies)[2]:.1f} ms, max {max(latencies):.1f} ms; auth, coalescing and stale-track guards passed"
        )
        state.update(uri="", supported=False)
        request("/sync", {"state": state, "results": []})
        status, accepted = request("/love", {"action": "randomize", "uri": "", "account": "test"})
        assert status == 202
        request("/sync", {"state": state, "results": [{"id": accepted["id"], "ok": True}]})
        body = {"action": "queue-toggle", "uri": "", "account": "test"}
        assert request("/love", body, auth=False)[0] == 401
        assert request("/love", body, origin="https://malicious.example")[0] == 403
        assert request("/love", {**body, "account": "other"})[0] == 409
        status, accepted = request("/love", body)
        assert status == 202
        assert request("/love", body)[0] == 409
        _, sync = request("/sync", {"state": state, "results": []})
        assert sync["commands"][0]["action"] == "queue-toggle"
        request("/sync", {"state": state, "results": [{"id": accepted["id"], "ok": True}]})
        assert request("/love", {**body, "action": "unknown"})[0] == 400
        print(
            "HTTP bridge authentication, origin, hidden panel, toggle and acknowledgement checks passed"
        )
    finally:
        process.terminate()
        process.wait(timeout=5)
