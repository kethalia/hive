// workspace-identity performs one fixed authenticated manifest read. It never
// changes a workspace, agent lifecycle, file, user credential or app resource.
package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/coder/v2/agent/proto"
	"github.com/coder/coder/v2/coderd/workspaceapps/appurl"
	"github.com/coder/coder/v2/codersdk/agentsdk"
	"github.com/google/uuid"
)

const sdkVersion = "v2.38.4"
const maxRPCBytes = 4 << 20

var unavailable = errors.New("workspace_identity_unavailable")
var namePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

type request struct {
	SchemaVersion      int    `json:"schemaVersion"`
	Kind               string `json:"kind"`
	CoderOrigin        string `json:"coderOrigin"`
	WorkspaceID        string `json:"workspaceId"`
	BuildID            string `json:"buildId"`
	AppID              string `json:"appId"`
	AppOrigin          string `json:"appOrigin"`
	ProvisionalAgentID string `json:"provisionalAgentId"`
}
type result struct {
	SchemaVersion      int    `json:"schemaVersion"`
	SDKVersion         string `json:"sdkVersion"`
	Kind               string `json:"kind"`
	CoderOrigin        string `json:"coderOrigin"`
	WorkspaceID        string `json:"workspaceId"`
	BuildID            string `json:"buildId"`
	AppID              string `json:"appId"`
	AppOrigin          string `json:"appOrigin"`
	ProvisionalAgentID string `json:"provisionalAgentId"`
	AgentID            string `json:"agentId"`
	ManifestBindingSHA string `json:"manifestBindingSha256,omitempty"`
}

func canonicalUUID(value string) bool {
	id, err := uuid.Parse(value)
	return err == nil && id != uuid.Nil && id.String() == value
}
func origin(value string) (*url.URL, error) {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.Host != strings.ToLower(u.Host) || strings.IndexFunc(u.Host, func(r rune) bool { return r > 127 }) >= 0 || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.String() != value {
		return nil, unavailable
	}
	return u, nil
}
func (r request) app() (slug, target string, err error) {
	switch r.Kind {
	case "workspace-read":
		return "hive-read", "http://127.0.0.1:13342", nil
	case "agent-tools":
		return "hive-agent", "http://127.0.0.1:13344", nil
	case "voice":
		return "hive-voice", "http://127.0.0.1:13343", nil
	case "project-host":
		return "codex-session", "http://127.0.0.1:13341", nil
	default:
		return "", "", unavailable
	}
}
func readRequest(reader io.Reader) (request, error) {
	var value request
	raw, err := io.ReadAll(io.LimitReader(reader, 8193))
	if err != nil || len(raw) > 8192 {
		return value, unavailable
	}
	d := json.NewDecoder(strings.NewReader(string(raw)))
	d.DisallowUnknownFields()
	if d.Decode(&value) != nil || d.Decode(new(any)) != io.EOF {
		return value, unavailable
	}
	// Duplicate keys are rejected independently of encoding/json's last-key rule.
	keys := json.NewDecoder(strings.NewReader(string(raw)))
	token, err := keys.Token()
	if err != nil || token != json.Delim('{') {
		return value, unavailable
	}
	seen := make(map[string]bool)
	allowed := map[string]bool{"schemaVersion": true, "kind": true, "coderOrigin": true, "workspaceId": true, "buildId": true, "appId": true, "appOrigin": true, "provisionalAgentId": true}
	for keys.More() {
		key, err := keys.Token()
		if err != nil {
			return value, unavailable
		}
		name, ok := key.(string)
		if !ok || !allowed[name] || seen[name] {
			return value, unavailable
		}
		seen[name] = true
		var item any
		if keys.Decode(&item) != nil {
			return value, unavailable
		}
	}
	if len(seen) != 8 || value.SchemaVersion != 1 {
		return value, unavailable
	}
	for _, id := range []string{value.WorkspaceID, value.BuildID, value.AppID, value.ProvisionalAgentID} {
		if !canonicalUUID(id) {
			return value, unavailable
		}
	}
	if _, err := origin(value.CoderOrigin); err != nil {
		return value, err
	}
	if _, err := origin(value.AppOrigin); err != nil {
		return value, err
	}
	_, _, err = value.app()
	return value, err
}

// The official SDK creates a new HTTP client when opening its websocket, so the
// RoundTripper itself enforces origin/path/query/status and redirect rejection.
type pinnedTransport struct {
	base   http.RoundTripper
	origin *url.URL
	token  string
}

func (p *pinnedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	q := req.URL.Query()
	if req.Method != "GET" || req.URL.Scheme != p.origin.Scheme || req.URL.Host != p.origin.Host || req.URL.Path != "/api/v2/workspaceagents/me/rpc" || req.URL.RawPath != "" || req.URL.User != nil || req.URL.Fragment != "" || len(q) != 2 || len(q["version"]) != 1 || q.Get("version") != "2.11" || len(q["role"]) != 1 || q.Get("role") != "client" || !hmac.Equal([]byte(req.Header.Get("Coder-Session-Token")), []byte(p.token)) {
		return nil, unavailable
	}
	response, err := p.base.RoundTrip(req)
	if err != nil {
		return nil, unavailable
	}
	if response.StatusCode != http.StatusSwitchingProtocols {
		response.Body.Close()
		return nil, unavailable
	}
	rwc, ok := response.Body.(io.ReadWriteCloser)
	if !ok {
		response.Body.Close()
		return nil, unavailable
	}
	response.Body = &boundedRPC{stream: rwc, readLeft: maxRPCBytes, writeLeft: 65536}
	return response, nil
}

type boundedRPC struct {
	stream              io.ReadWriteCloser
	readMu, writeMu     sync.Mutex
	readLeft, writeLeft int
}

func (s *boundedRPC) Read(b []byte) (int, error) {
	s.readMu.Lock()
	defer s.readMu.Unlock()
	left := s.readLeft
	if left <= 0 {
		s.Close()
		return 0, unavailable
	}
	if len(b) > left {
		b = b[:left]
	}
	n, err := s.stream.Read(b)
	s.readLeft -= n
	return n, err
}
func (s *boundedRPC) Write(b []byte) (int, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if len(b) > s.writeLeft {
		s.Close()
		return 0, unavailable
	}
	s.writeLeft -= len(b)
	return s.stream.Write(b)
}
func (s *boundedRPC) Close() error { return s.stream.Close() }

func readManifest(ctx context.Context, expected request, token string) (*proto.Manifest, error) {
	base := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 3 * time.Second}).DialContext, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, TLSHandshakeTimeout: 3 * time.Second, ResponseHeaderTimeout: 3 * time.Second, MaxResponseHeaderBytes: 16384}
	defer base.CloseIdleConnections()
	return fetchManifest(ctx, expected, token, base)
}

// Transport injection is internal Go test composition, never a CLI/config option.
func fetchManifest(ctx context.Context, expected request, token string, base http.RoundTripper) (*proto.Manifest, error) {
	u, err := origin(expected.CoderOrigin)
	if err != nil {
		return nil, err
	}
	client := agentsdk.New(u, agentsdk.WithFixedToken(token))
	client.SDK.HTTPClient.Transport = &pinnedTransport{base: base, origin: u, token: token}
	rpc, _, err := client.ConnectRPC211WithRole(ctx, "client")
	if err != nil {
		return nil, unavailable
	}
	manifest, readErr := rpc.GetManifest(ctx, &proto.GetManifestRequest{})
	manifest = minimizeManifest(manifest)
	closeErr := rpc.DRPCConn().Close()
	if readErr != nil || closeErr != nil {
		return nil, unavailable
	}
	return manifest, nil
}

// Retain only identity fields. Go may retain prior allocations until GC; this
// is data minimization, not a claim of secure memory erasure.
func minimizeManifest(m *proto.Manifest) *proto.Manifest {
	if m == nil {
		return nil
	}
	out := &proto.Manifest{AgentId: m.AgentId, WorkspaceId: m.WorkspaceId, AgentName: m.AgentName, WorkspaceName: m.WorkspaceName, OwnerUsername: m.OwnerUsername, EnvironmentVariables: map[string]string{"HIVE_RUNTIME_BUILD_ID": m.EnvironmentVariables["HIVE_RUNTIME_BUILD_ID"]}}
	if len(m.Apps) > 128 {
		return out
	}
	for _, a := range m.Apps {
		if a == nil {
			out.Apps = append(out.Apps, nil)
			continue
		}
		out.Apps = append(out.Apps, &proto.WorkspaceApp{Id: a.Id, Url: a.Url, External: a.External, Slug: a.Slug, Subdomain: a.Subdomain, SubdomainName: a.SubdomainName, SharingLevel: a.SharingLevel})
	}
	return out
}

func validateManifest(expected request, manifest *proto.Manifest) (result, error) {
	var empty result
	if manifest == nil {
		return empty, unavailable
	}
	agent, err := uuid.FromBytes(manifest.AgentId)
	workspace, werr := uuid.FromBytes(manifest.WorkspaceId)
	if err != nil || werr != nil || agent == uuid.Nil || workspace.String() != expected.WorkspaceID || !namePattern.MatchString(manifest.AgentName) || !namePattern.MatchString(manifest.WorkspaceName) || !namePattern.MatchString(manifest.OwnerUsername) || manifest.EnvironmentVariables["HIVE_RUNTIME_BUILD_ID"] != expected.BuildID {
		return empty, unavailable
	}
	slug, target, err := expected.app()
	if err != nil {
		return empty, err
	}
	u, originErr := origin(expected.AppOrigin)
	if originErr != nil {
		return empty, unavailable
	}
	appURL := appurl.ApplicationURL{AppSlugOrPort: slug, AgentName: manifest.AgentName, WorkspaceName: manifest.WorkspaceName, Username: manifest.OwnerUsername}
	label := appURL.String()
	// Coder db2sdk.AppSubdomain omits AgentName for named (non-port) apps.
	// Our configured origin keeps its explicit-agent alias, pinned above; the
	// manifest's canonical label is checked independently on the same agent.
	appURL.AgentName = ""
	canonicalNamedLabel := appURL.String()
	if len(label) > 63 || strings.Split(u.Hostname(), ".")[0] != label {
		return empty, unavailable
	}
	if len(manifest.Apps) > 128 {
		return empty, unavailable
	}
	matches := 0
	for _, app := range manifest.Apps {
		if app == nil {
			return empty, unavailable
		}
		id, err := uuid.FromBytes(app.Id)
		if err != nil {
			return empty, unavailable
		}
		if id.String() == expected.AppID || app.Slug == slug {
			if id.String() != expected.AppID || app.Slug != slug || app.External || !app.Subdomain || app.SubdomainName != canonicalNamedLabel || app.SharingLevel != proto.WorkspaceApp_OWNER || strings.TrimSuffix(app.Url, "/") != target {
				return empty, unavailable
			}
			matches++
		}
	}
	if matches != 1 {
		return empty, unavailable
	}
	value := result{SchemaVersion: 1, SDKVersion: sdkVersion, Kind: expected.Kind, CoderOrigin: expected.CoderOrigin, WorkspaceID: expected.WorkspaceID, BuildID: expected.BuildID, AppID: expected.AppID, AppOrigin: expected.AppOrigin, ProvisionalAgentID: expected.ProvisionalAgentID, AgentID: agent.String()}
	raw, _ := json.Marshal(value)
	digest := sha256.Sum256(raw)
	value.ManifestBindingSHA = hex.EncodeToString(digest[:])
	return value, nil
}
func credential() (string, error) {
	// Only the platform agent credential, never CODER_SESSION_TOKEN or a CLI store.
	token := os.Getenv("CODER_AGENT_TOKEN")
	file := os.Getenv("CODER_AGENT_TOKEN_FILE")
	if file != "" {
		fd, err := syscall.Open(file, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
		if err != nil {
			return "", unavailable
		}
		f := os.NewFile(uintptr(fd), "agent-credential")
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			return "", unavailable
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > 4096 || stat.Nlink != 1 || (stat.Uid != uint32(os.Getuid()) && stat.Uid != 0) {
			return "", unavailable
		}
		raw, err := io.ReadAll(io.LimitReader(f, 4097))
		if err != nil || len(raw) > 4096 {
			return "", unavailable
		}
		fromFile := strings.TrimSpace(string(raw))
		if token != "" && token != fromFile {
			return "", unavailable
		}
		token = fromFile
	}
	if token == "" || len(token) > 4096 || strings.IndexFunc(token, func(r rune) bool { return r <= 32 || r >= 127 }) >= 0 {
		return "", unavailable
	}
	return token, nil
}
func run() error {
	if len(os.Args) != 1 {
		return unavailable
	}
	expected, err := readRequest(os.Stdin)
	if err != nil {
		return err
	}
	agentOrigin, err := origin(strings.TrimSuffix(os.Getenv("CODER_AGENT_URL"), "/"))
	if err != nil || agentOrigin.String() != expected.CoderOrigin {
		return unavailable
	}
	token, err := credential()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	manifest, err := readManifest(ctx, expected, token)
	if err != nil {
		return err
	}
	value, err := validateManifest(expected, manifest)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(value)
}
func main() {
	// Bounds stdin and final close as well as the SDK context. This fixed helper
	// has no child processes or writes to reap; process exit closes its sockets.
	timer := time.AfterFunc(10*time.Second, func() { fmt.Fprintln(os.Stderr, "workspace_identity_unavailable"); os.Exit(1) })
	defer timer.Stop()
	if run() != nil {
		fmt.Fprintln(os.Stderr, "workspace_identity_unavailable")
		os.Exit(1)
	}
}
