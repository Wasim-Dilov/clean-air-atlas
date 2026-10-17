"""Atmosphere Data Store (ADS) retrieve API, called with the standard library.

Same REST flow as the official ecmwf-datastores client:
  POST {api}/retrieve/v1/processes/{dataset}/execution  {"inputs": request}
  GET  {api}/retrieve/v1/jobs/{jobID}                     status: accepted | running | successful | failed | rejected
  GET  {api}/retrieve/v1/jobs/{jobID}/results             asset.value.href -> file
The personal access token goes in the PRIVATE-TOKEN header. The dataset licence must
have been accepted once on the ADS website, or every request fails.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import urljoin

from . import net

log = logging.getLogger(__name__)

DEFAULT_URL = "https://ads.atmosphere.copernicus.eu/api"


class ADSError(RuntimeError):
    pass


@dataclass
class ADSClient:
    key: str
    url: str = DEFAULT_URL
    poll_s: float = 15.0
    timeout_s: float = 20 * 60
    send: Callable[..., bytes] = field(default=net.request)
    sleep: Callable[[float], None] = field(default=time.sleep)
    clock: Callable[[], float] = field(default=time.monotonic)

    def _headers(self) -> dict[str, str]:
        return {"PRIVATE-TOKEN": self.key, "Accept": "application/json"}

    def _json(self, url: str, payload: dict | None = None) -> Any:
        if payload is None:
            body = self.send(url, self._headers())
        else:
            body = self.send(url, {**self._headers(), "Content-Type": "application/json"},
                             data=json.dumps(payload).encode(), method="POST")
        return json.loads(body)

    def retrieve(self, dataset: str, request: dict[str, Any]) -> bytes:
        """Submit, wait (up to timeout_s) and return the result file's bytes."""
        base = self.url.rstrip("/") + "/retrieve/v1"
        job = self._json(f"{base}/processes/{dataset}/execution", {"inputs": request})
        job_id = job.get("jobID")
        if not job_id:
            raise ADSError(f"no job id in response: {job}")
        log.info("ADS job %s submitted for %s", job_id, dataset)

        started = self.clock()
        status = job.get("status", "accepted")
        while status in ("accepted", "running", "queued"):
            if self.clock() - started > self.timeout_s:
                raise ADSError(f"ADS job {job_id} still {status} after {self.timeout_s:.0f}s; keeping previous frames")
            self.sleep(self.poll_s)
            status = self._json(f"{base}/jobs/{job_id}").get("status", "unknown")
        if status != "successful":
            raise ADSError(f"ADS job {job_id} ended with status {status!r}")

        results_url = f"{base}/jobs/{job_id}/results"
        results = self._json(results_url)
        asset = (results.get("asset") or {}).get("value") or {}
        href = asset.get("href")
        if not href:
            raise ADSError(f"no download link for job {job_id}")
        data = self.send(urljoin(results_url, href), {})
        size = asset.get("file:size")
        if size is not None and int(size) != len(data):
            raise ADSError(f"download incomplete: {len(data)} of {size} bytes")
        log.info("ADS job %s downloaded %d bytes", job_id, len(data))
        return data
