package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/coder/v2/agent/proto"
	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/hashicorp/yamux"
	"storj.io/drpc/drpcmux"
	"storj.io/drpc/drpcserver"
)

func fixture() (request, *proto.Manifest) {
	r := request{1, "workspace-read", "https://coder.example.test", uuid.NewString(), uuid.NewString(), uuid.NewString(), "https://hive-read--main--work--owner.apps.example.test", uuid.NewString()}
	a, w, id := uuid.New(), uuid.MustParse(r.WorkspaceID), uuid.MustParse(r.AppID)
	m := &proto.Manifest{AgentId: a[:], WorkspaceId: w[:], AgentName: "main", WorkspaceName: "work", OwnerUsername: "owner", EnvironmentVariables: map[string]string{"HIVE_RUNTIME_BUILD_ID": r.BuildID}, Apps: []*proto.WorkspaceApp{{Id: id[:], Url: "http://127.0.0.1:13342", Slug: "hive-read", Subdomain: true, SubdomainName: "hive-read--work--owner", SharingLevel: proto.WorkspaceApp_OWNER}}}
	return r, m
}
func TestStrictRequest(t *testing.T) {
	r, _ := fixture()
	raw, _ := json.Marshal(r)
	if _, err := readRequest(strings.NewReader(string(raw))); err != nil {
		t.Fatal("valid request rejected")
	}
	for _, bad := range []string{string(raw) + "{}", strings.Replace(string(raw), `"kind":`, `"Kind":`, 1), strings.Replace(string(raw), `"schemaVersion":1`, `"schemaVersion":1,"schemaVersion":1`, 1), strings.Replace(string(raw), `"kind":`, `"unknown":true,"kind":`, 1), strings.Replace(string(raw), "https://coder.example.test", "http://coder.example.test", 1), strings.Replace(string(raw), r.BuildID, strings.ToUpper(r.BuildID), 1), strings.Repeat(" ", 8193)} {
		if _, err := readRequest(strings.NewReader(bad)); err == nil {
			t.Fatal("invalid request accepted")
		}
	}
}
func TestManifestBinding(t *testing.T) {
	tests := map[string]func(*proto.Manifest){
		"missing build":                   func(m *proto.Manifest) { delete(m.EnvironmentVariables, "HIVE_RUNTIME_BUILD_ID") },
		"wrong build":                     func(m *proto.Manifest) { m.EnvironmentVariables["HIVE_RUNTIME_BUILD_ID"] = uuid.NewString() },
		"foreign workspace":               func(m *proto.Manifest) { v := uuid.New(); m.WorkspaceId = v[:] },
		"owner":                           func(m *proto.Manifest) { m.OwnerUsername = "other" },
		"agent":                           func(m *proto.Manifest) { m.AgentName = "other" },
		"foreign app":                     func(m *proto.Manifest) { v := uuid.New(); m.Apps[0].Id = v[:] },
		"target":                          func(m *proto.Manifest) { m.Apps[0].Url = "http://127.0.0.1:22" },
		"sharing":                         func(m *proto.Manifest) { m.Apps[0].SharingLevel = proto.WorkspaceApp_PUBLIC },
		"subdomain":                       func(m *proto.Manifest) { m.Apps[0].SubdomainName = "wrong" },
		"explicit alias is not canonical": func(m *proto.Manifest) { m.Apps[0].SubdomainName = "hive-read--main--work--owner" },
		"empty canonical label":           func(m *proto.Manifest) { m.Apps[0].SubdomainName = "" },
		"duplicate app":                   func(m *proto.Manifest) { m.Apps = append(m.Apps, m.Apps[0]) },
		"nil app":                         func(m *proto.Manifest) { m.Apps = append(m.Apps, nil) },
	}
	r, m := fixture()
	v, err := validateManifest(r, m)
	if err != nil || v.AgentID == r.ProvisionalAgentID || len(v.ManifestBindingSHA) != 64 {
		t.Fatal("actual runtime agent normalization failed")
	}
	r.AppOrigin = "https://hive-read--other--work--owner.apps.example.test"
	if _, err := validateManifest(r, m); err == nil {
		t.Fatal("configured explicit-agent alias lost its agent binding")
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			r, m := fixture()
			mutate(m)
			if _, err := validateManifest(r, m); err == nil {
				t.Fatal("unbound manifest accepted")
			}
		})
	}
}
func TestCredentialBoundary(t *testing.T) {
	t.Setenv("CODER_AGENT_TOKEN", "")
	t.Setenv("CODER_AGENT_TOKEN_FILE", "")
	t.Setenv("CODER_SESSION_TOKEN", "owner-must-not-be-read")
	if _, err := credential(); err == nil {
		t.Fatal("owner credential fallback")
	}
	file := filepath.Join(t.TempDir(), "agent")
	if err := os.WriteFile(file, []byte("fixture-agent\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODER_AGENT_TOKEN_FILE", file)
	if token, err := credential(); err != nil || token != "fixture-agent" {
		t.Fatal("private credential rejected")
	}
	t.Setenv("CODER_AGENT_TOKEN", "different")
	if _, err := credential(); err == nil {
		t.Fatal("conflicting credentials accepted")
	}
	t.Setenv("CODER_AGENT_TOKEN", "")
	link := file + "-link"
	if err := os.Symlink(file, link); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODER_AGENT_TOKEN_FILE", link)
	if _, err := credential(); err == nil {
		t.Fatal("symlink accepted")
	}
	t.Setenv("CODER_AGENT_TOKEN_FILE", file)
	if err := os.Link(file, file+"-hard"); err != nil {
		t.Fatal(err)
	}
	if _, err := credential(); err == nil {
		t.Fatal("multiply linked credential accepted")
	}
}

type manifestServer struct {
	proto.DRPCAgentUnimplementedServer
	manifest *proto.Manifest
	calls    *atomic.Int32
	wait     bool
}

func (s *manifestServer) GetManifest(ctx context.Context, _ *proto.GetManifestRequest) (*proto.Manifest, error) {
	s.calls.Add(1)
	if s.wait {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return s.manifest, nil
}
func TestOfficialSDKManifestRPC(t *testing.T) {
	for _, mode := range []string{"valid", "redirect", "timeout"} {
		t.Run(mode, func(t *testing.T) {
			r, m := fixture()
			var calls, requests atomic.Int32
			mux := drpcmux.New()
			if err := proto.DRPCRegisterAgent(mux, &manifestServer{manifest: m, calls: &calls, wait: mode == "timeout"}); err != nil {
				t.Fatal(err)
			}
			srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				requests.Add(1)
				if req.URL.Path != "/api/v2/workspaceagents/me/rpc" || req.URL.Query().Get("role") != "client" || req.URL.Query().Get("version") != "2.11" || req.Header.Get("Coder-Session-Token") != "fixture-agent" {
					w.WriteHeader(403)
					return
				}
				if mode == "redirect" {
					w.Header().Set("Location", "https://different.example.test")
					w.WriteHeader(307)
					return
				}
				ws, err := websocket.Accept(w, req, nil)
				if err != nil {
					return
				}
				defer ws.CloseNow()
				conn := websocket.NetConn(req.Context(), ws, websocket.MessageBinary)
				cfg := yamux.DefaultConfig()
				cfg.LogOutput = io.Discard
				session, err := yamux.Server(conn, cfg)
				if err != nil {
					return
				}
				defer session.Close()
				_ = drpcserver.New(mux).Serve(req.Context(), session)
			}))
			defer srv.Close()
			r.CoderOrigin = srv.URL
			ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
			defer cancel()
			got, err := fetchManifest(ctx, r, "fixture-agent", srv.Client().Transport)
			if mode == "valid" {
				if err != nil || got == nil || calls.Load() != 1 {
					t.Fatal("official SDK single GetManifest failed")
				}
				if _, err := validateManifest(r, got); err != nil {
					t.Fatal("SDK manifest rejected")
				}
			} else if err == nil {
				t.Fatal("unsafe transport accepted")
			}
			if requests.Load() != 1 {
				t.Fatal("unexpected followup HTTP request")
			}
		})
	}
}

func TestMinimizeManifest(t *testing.T) {
	_, m := fixture()
	m.EnvironmentVariables["SECRET"] = "fixture-sensitive"
	m.Secrets = []*proto.WorkspaceSecret{{}}
	m.Directory = "unrelated"
	m.Apps[0].Command = "unrelated"
	got := minimizeManifest(m)
	if len(got.Secrets) != 0 || len(got.EnvironmentVariables) != 1 || got.Directory != "" || got.Apps[0].Command != "" {
		t.Fatal("unrelated manifest data retained")
	}
}

// This opt-in test is compiled into a separate diagnostic test artifact, never
// the installed CLI. Missing provisioner build metadata remains a negative
// normalization result; no input can fill or override manifest fields.
func TestLiveReadOnlyManifest(t *testing.T) {
	if os.Getenv("HIVE_WORKSPACE_IDENTITY_LIVE") != "1" {
		t.Skip("bounded agent-local diagnostic only")
	}
	var input struct {
		Request         request `json:"request"`
		ExpectedAgentID string  `json:"expectedAgentId"`
	}
	d := json.NewDecoder(io.LimitReader(os.Stdin, 16385))
	d.DisallowUnknownFields()
	if d.Decode(&input) != nil || d.Decode(new(any)) != io.EOF || !canonicalUUID(input.ExpectedAgentID) {
		t.Fatal("invalid diagnostic scope")
	}
	raw, _ := json.Marshal(input.Request)
	expected, err := readRequest(strings.NewReader(string(raw)))
	if err != nil {
		t.Fatal("invalid request")
	}
	if strings.TrimSuffix(os.Getenv("CODER_AGENT_URL"), "/") != expected.CoderOrigin {
		t.Fatal("platform origin mismatch")
	}
	token, err := credential()
	if err != nil {
		t.Fatal("agent credential unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	m, err := readManifest(ctx, expected, token)
	if err != nil {
		t.Fatal("manifest RPC unavailable")
	}
	actual, err := uuid.FromBytes(m.AgentId)
	if err != nil {
		t.Fatal("manifest identity unavailable")
	}
	value, validationErr := validateManifest(expected, m)
	report := map[string]any{"schemaVersion": 1, "rpcRead": true, "agentMatchesOwnerAPI": actual.String() == input.ExpectedAgentID, "agentDiffersFromProvisional": actual.String() != expected.ProvisionalAgentID, "workspaceMatches": uuid.MustParse(expected.WorkspaceID) == uuid.Must(uuid.FromBytes(m.WorkspaceId)), "buildMetadataPresent": m.EnvironmentVariables["HIVE_RUNTIME_BUILD_ID"] != "", "buildMatches": m.EnvironmentVariables["HIVE_RUNTIME_BUILD_ID"] == expected.BuildID, "normalizationAccepted": validationErr == nil, "sdkVersion": sdkVersion}
	if validationErr == nil && value.AgentID != input.ExpectedAgentID {
		t.Fatal("normalized agent mismatch")
	}
	if json.NewEncoder(os.Stdout).Encode(report) != nil {
		t.Fatal("diagnostic output unavailable")
	}
	if actual.String() != input.ExpectedAgentID {
		t.Fatal("owner API identity mismatch")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestRPCPreflightPins(t *testing.T) {
	u, _ := origin("https://coder.example.test")
	for _, change := range []func(*http.Request){
		func(r *http.Request) { r.Method = "POST" }, func(r *http.Request) { r.URL.Host = "other.example.test" }, func(r *http.Request) { r.URL.Path = "/api/v2/users/me" }, func(r *http.Request) { r.URL.RawQuery = "role=agent&version=2.11" }, func(r *http.Request) { r.URL.RawQuery = "role=client&version=2.11&role=client" }, func(r *http.Request) { r.Header.Set("Coder-Session-Token", "wrong") },
	} {
		calls := 0
		p := &pinnedTransport{base: roundTripFunc(func(*http.Request) (*http.Response, error) { calls++; return nil, unavailable }), origin: u, token: "fixture-agent"}
		r, _ := http.NewRequest("GET", "https://coder.example.test/api/v2/workspaceagents/me/rpc?role=client&version=2.11", nil)
		r.Header.Set("Coder-Session-Token", "fixture-agent")
		change(r)
		if _, err := p.RoundTrip(r); err == nil || calls != 0 {
			t.Fatal("invalid RPC reached transport")
		}
	}
}

type memoryStream struct {
	reader io.Reader
	closed bool
}

func (s *memoryStream) Read(b []byte) (int, error)  { return s.reader.Read(b) }
func (s *memoryStream) Write(b []byte) (int, error) { return len(b), nil }
func (s *memoryStream) Close() error                { s.closed = true; return nil }
func TestRPCWireBudget(t *testing.T) {
	stream := &memoryStream{reader: strings.NewReader("12345")}
	bounded := &boundedRPC{stream: stream, readLeft: 4, writeLeft: 3}
	b := make([]byte, 8)
	if n, _ := bounded.Read(b); n != 4 {
		t.Fatal("incoming cap not applied")
	}
	if _, err := bounded.Read(b); err == nil || !stream.closed {
		t.Fatal("incoming cap not closed")
	}
	if _, err := bounded.Write([]byte("1234")); err == nil {
		t.Fatal("outgoing cap not applied")
	}
}
