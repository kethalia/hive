"""Bounded read-only Infrastructure-profile probe for the exact native-final deployment.
Credential arrives only on SSH stdin and is held in memory; raw specs/logs are never emitted.
"""
import datetime,json,os,re,ssl,sys,time,urllib.request,urllib.error,urllib.parse
ORIGIN='https://rancher.local.kethalia.com'
NAMESPACE='coder'
DEPLOYMENT='coder-e6aa588f-89a7-464b-9cf9-a6371d0b819d'
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
class ProbeFailure(Exception):
 def __init__(self,code,status=None):self.code=code;self.status=status

def redactor(secrets):
 values=sorted({v for v in secrets if isinstance(v,str) and v},key=len,reverse=True)
 def clean(value):
  text=str(value)
  for secret in values:text=text.replace(secret,'[REDACTED]')
  text=re.sub(r'(?i)\b(Bearer|Basic)\s+[^\s,;]+',r'\1 [REDACTED]',text)
  text=re.sub(r'(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|token-[A-Za-z0-9]+:[A-Za-z0-9]+)','[REDACTED]',text)
  text=re.sub(r'(?i)((?:token|password|secret|authorization|credential)\s*[:=]\s*)[^\s,;]+',r'\1[REDACTED]',text)
  def url(m):
   try:
    u=urllib.parse.urlsplit(m.group());return urllib.parse.urlunsplit((u.scheme,u.hostname or '',u.path,'',''))
   except Exception:return '[REDACTED_URL]'
  text=re.sub(r'https?://[^\s<>"\']+',url,text)
  return text[:2000]
 return clean

def execute():
 if os.environ.get('HIVE_WORKSPACE_PROFILE')!='infrastructure':raise ProbeFailure('wrong_workspace_profile')
 if 'CODER_SESSION_TOKEN' in os.environ:raise ProbeFailure('owner_coder_credential_present')
 raw=sys.stdin.buffer.read(8193)
 if not 0<len(raw)<=8192:raise ProbeFailure('credential_input_bounds')
 token=raw.decode().strip();del raw
 if not token or '\n' in token or '\r' in token:raise ProbeFailure('credential_input_invalid')
 opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect());deadline=time.monotonic()+75
 def get(path):
  if not path.startswith('/') or path.startswith('//'):raise ProbeFailure('fixed_origin_violation')
  remaining=deadline-time.monotonic()
  if remaining<=0:raise ProbeFailure('probe_deadline')
  q=urllib.request.Request(ORIGIN+path,headers={'Authorization':'Bearer '+token,'Accept':'application/json'},method='GET')
  try:
   with opener.open(q,timeout=min(15,remaining)) as r:
    data=r.read(2*1024*1024+1)
    if r.status!=200 or len(data)>2*1024*1024:raise ProbeFailure('response_bounds',r.status)
    return json.loads(data)
  except urllib.error.HTTPError as e:raise ProbeFailure('http_status',e.code) from None
 cluster='local'
 path='/k8s/clusters/local/apis/apps/v1/namespaces/'+NAMESPACE+'/deployments/'+DEPLOYMENT
 try:deployment=get(path)
 except ProbeFailure as e:
  if e.status not in [401,404]:raise
  clusters=get('/v3/clusters?name=local');local=[c for c in clusters.get('data',[]) if c.get('name')=='local' and c.get('id')=='local']
  if len(local)!=1:raise ProbeFailure('local_cluster_not_verified')
  # The fixed local endpoint was not available: metadata is factual, not permission
  # to select another cluster, alter TLS, or broaden the namespace/pod scope.
  raise ProbeFailure('local_kubernetes_endpoint_unavailable',e.status)
 if deployment.get('kind')!='Deployment' or deployment.get('metadata',{}).get('name')!=DEPLOYMENT or deployment['metadata'].get('namespace')!=NAMESPACE:raise ProbeFailure('deployment_identity')
 selector=deployment['spec']['selector'];labels=selector.get('matchLabels',{})
 if not labels or selector.get('matchExpressions') or len(labels)>16:raise ProbeFailure('selector_not_exact')
 if any(not re.fullmatch(r'[A-Za-z0-9_.\-/]+',str(x)) for pair in labels.items() for x in pair):raise ProbeFailure('selector_invalid')
 labelSelector=','.join(k+'='+v for k,v in sorted(labels.items()))
 pods=get('/k8s/clusters/local/api/v1/namespaces/'+NAMESPACE+'/pods?'+urllib.parse.urlencode({'labelSelector':labelSelector,'limit':'10'}))
 if pods.get('metadata',{}).get('continue') or len(pods.get('items',[]))>4:raise ProbeFailure('pod_scope_bound')
 knownSecrets=[token]+[v for k,v in os.environ.items() if re.search('token|secret|password|credential|auth|github|key',k,re.I)]
 objects=[deployment['spec']['template']]+pods.get('items',[])
 for obj in objects:
  for c in obj.get('spec',{}).get('initContainers',[])+obj.get('spec',{}).get('containers',[]):
   for item in c.get('env',[]):
    value=item.get('value')
    if isinstance(value,str) and (re.search('token|secret|password|credential|auth|github|key',item.get('name',''),re.I) or len(value)>=32):knownSecrets.append(value)
 clean=redactor(knownSecrets)
 def state(v):
  result={}
  for phase in ['waiting','running','terminated']:
   if phase in v:result[phase]={k:clean(x) if isinstance(x,str) else x for k,x in v[phase].items() if k in ['reason','message','exitCode','signal','startedAt','finishedAt']}
  return result
 output=[]
 for pod in pods.get('items',[]):
  meta=pod.get('metadata',{});uid=meta.get('uid','');name=meta.get('name','')
  if meta.get('namespace')!=NAMESPACE or not name.startswith(DEPLOYMENT+'-') or not re.fullmatch(r'[a-f0-9-]{36}',uid) or any(meta.get('labels',{}).get(k)!=v for k,v in labels.items()):raise ProbeFailure('pod_identity')
  events=get('/k8s/clusters/local/api/v1/namespaces/'+NAMESPACE+'/events?'+urllib.parse.urlencode({'fieldSelector':'involvedObject.uid='+uid,'limit':'100'}))
  if events.get('metadata',{}).get('continue') or len(events.get('items',[]))>100:raise ProbeFailure('event_scope_bound')
  relevant=[]
  for event in events.get('items',[]):
   involved=event.get('involvedObject',{})
   if involved.get('uid')!=uid or involved.get('name')!=name or involved.get('namespace')!=NAMESPACE:raise ProbeFailure('event_identity')
   relevant.append({k:clean(event[k]) if isinstance(event[k],str) else event[k] for k in ['type','reason','message','count','firstTimestamp','lastTimestamp'] if k in event})
  spec=pod['spec'];status=pod.get('status',{})
  def containers(kind,statusKind):
   states={s['name']:s for s in status.get(statusKind,[])}
   return [{'name':clean(c['name']),'image':clean(c['image']),'ready':states.get(c['name'],{}).get('ready'),'restartCount':states.get(c['name'],{}).get('restartCount'),'state':state(states.get(c['name'],{}).get('state',{})),'lastState':state(states.get(c['name'],{}).get('lastState',{}))} for c in spec.get(kind,[])]
  output.append({'name':name,'uid':uid,'node':clean(spec.get('nodeName','')),'phase':clean(status.get('phase','')),'reason':clean(status.get('reason','')),'conditions':[{k:clean(c[k]) for k in ['type','status','reason','message'] if k in c} for c in status.get('conditions',[])],'initContainers':containers('initContainers','initContainerStatuses'),'devContainers':containers('containers','containerStatuses'),'events':relevant})
 return {'schemaVersion':1,'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'profileVerified':'infrastructure','ownerCoderCredentialAbsent':True,'cluster':cluster,'namespace':NAMESPACE,'deployment':DEPLOYMENT,'pods':output,'providerWrites':False,'rawSpecOrLogsEmitted':False,'redaction':'Known credential/env secret values and long inline values removed in memory; authorization/token patterns and URL userinfo/query stripped. Secret references were not fetched.'}
if __name__=='__main__':
 try:print(json.dumps(execute(),sort_keys=True))
 except ProbeFailure as e:print(json.dumps({'error':e.code,'httpStatus':e.status,'providerWrites':False}));sys.exit(1)
 except (ssl.SSLError,urllib.error.URLError) as e:
  tls=isinstance(e,ssl.SSLError) or isinstance(getattr(e,'reason',None),ssl.SSLError)
  print(json.dumps({'error':'tls_verification_failed' if tls else 'network_unavailable','tlsVerificationDisabled':False,'providerWrites':False}));sys.exit(1)
 except Exception:print(json.dumps({'error':'bounded_probe_failed','providerWrites':False}));sys.exit(1)
