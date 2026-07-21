import json, os, time, urllib.request
import harness as H
tasks = json.load(open('broadening-tasks.json', encoding='utf-8'))
CUR = {}
def patched(model, messages, temperature=0.0, max_tokens=6000, timeout=180):
    body=json.dumps({'model':model,'messages':messages,'temperature':temperature,'max_tokens':max_tokens}).encode()
    req=urllib.request.Request(H.API_URL, data=body, headers={'Authorization':'Bearer '+H._api_key(),'Content-Type':'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d=json.loads(r.read())
    u=d.get('usage',{})
    if 'flash' in model:
        CUR['fhit']=CUR.get('fhit',0)+u.get('prompt_cache_hit_tokens',0)
        CUR['fmiss']=CUR.get('fmiss',0)+u.get('prompt_cache_miss_tokens',0)
        CUR['fout']=CUR.get('fout',0)+u.get('completion_tokens',0)
    else:
        CUR['pin']=CUR.get('pin',0)+u.get('prompt_tokens',0); CUR['pout']=CUR.get('pout',0)+u.get('completion_tokens',0)
    return d['choices'][0]['message']['content'] or ''
H.call_deepseek=patched
print('warming', H.nc_cmd(['goto','https://example.com/'], timeout=120, engine='headless')[:40].replace(chr(10),' '), flush=True)
res=[]
for i,t in enumerate(tasks):
    CUR.clear(); t0=time.time()
    try:
        ans,log=H.condition_B(t); v,_=H.judge(t, ans); steps=len(log)
    except Exception as e:
        ans,v,steps='ERR:%s'%e,'INCORRECT',0
    cost=CUR.get('fmiss',0)*0.14/1e6+CUR.get('fhit',0)*0.0028/1e6+CUR.get('fout',0)*0.28/1e6+CUR.get('pin',0)*0.435/1e6+CUR.get('pout',0)*0.87/1e6
    row={'idx':t['task_idx'],'verdict':v,'steps':steps,'secs':round(time.time()-t0,1),'cost':round(cost,5),'site':t['website'][:28],'ans':ans[:50].replace(chr(10),' ')}
    res.append(row); print(i+1, row, flush=True)
    json.dump(res, open('broadening-results.json','w'), ensure_ascii=False, indent=2)
c=sum(1 for r in res if r['verdict']=='CORRECT'); p=sum(1 for r in res if r['verdict']=='PARTIAL')
tot=sum(r['cost'] for r in res)
print('BROADENING B (n=%d): %d CORRECT (%.0f%%) %d PARTIAL %d INCORRECT | $%.4f total, $%.5f/task'%(len(res),c,100*c/len(res),p,len(res)-c-p,tot,tot/len(res)), flush=True)
