"""Actual protected published objects, explicit fixture provider; no network."""
import copy
import importlib.util
from pathlib import Path
import unittest


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value

FIXTURE=load("acceptance_published_fixture",Path(__file__).with_name("test_delivery_source_apply_worker.py"))
MODULE=load("acceptance_material",FIXTURE.WORKER.with_name("delivery-acceptance-material.py"))

class AcceptanceMaterialTests(unittest.TestCase):
    def setUp(self):
        self.fixture=FIXTURE.PublishedObjectTests("runTest");self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)

    def test_reads_only_sealed_candidate_and_preserves_every_publisher_byte(self):
        f=self.fixture;before=f.snapshot();result=MODULE.read_candidate(f.state,f.home)
        self.assertEqual(len(result["contents"]),len(result["manifest"]["files"]))
        self.assertEqual(MODULE.module.sha(MODULE.module.canonical(result["manifest"])),f.state["accepted"]["manifestDigest"])
        self.assertEqual(f.snapshot(),before)

    def test_foreign_operation_scope_or_expired_source_is_rejected(self):
        f=self.fixture
        for alter in [lambda x:x.update(expiresAt=1),lambda x:x.update(isCurrent=False),lambda x:x["accepted"].update(treeSha="a"*40),lambda x:x["scope"].update(taskId="00000000-0000-4000-8000-000000000001")]:
            value=copy.deepcopy(f.state);alter(value)
            with self.assertRaises(Exception):MODULE.read_candidate(value,f.home)

    def test_modified_sealed_bytes_cannot_become_acceptance_material(self):
        f=self.fixture;path=next((f.root/"sealed").iterdir());path.write_bytes(b"replacement")
        with self.assertRaises(Exception):MODULE.read_candidate(f.state,f.home)

if __name__=="__main__":unittest.main()
