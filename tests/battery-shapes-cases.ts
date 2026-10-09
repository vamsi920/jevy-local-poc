// Answer-shape battery: summaries, record deep dives, jokes, vague asks and questions that must NOT be
// mistaken for them. Each case names the expected shape; oracle values (independent SQL) must appear in
// the answer. A raw row dump never passes unless the question asked for rows.
// Never imported by backend code.
import type {BatteryCase} from './battery-cases.js';
const c=(id:string,turns:string|string[],shape:NonNullable<BatteryCase['shape']>,oracle?:string|string[],values?:(string|number)[]):BatteryCase=>({id,split:'fresh',category:'shape-'+shape,turns:Array.isArray(turns)?turns:[turns],check:'shape',shape,oracle,values});
export const batteryShapes:BatteryCase[]=[
 // ---- overviews: one table, no explicit measure ----
 c('o01','give me a summary of servers we have','overview',"SELECT count(*) FROM servers"),
 c('o02','summarize the vulnerabilities','overview',"SELECT count(*) FROM vulnerabilities"),
 c('o03','overview of incidents','overview',"SELECT count(*) FROM incidents"),
 c('o04','what do we have in backups','overview',"SELECT count(*) FROM backups"),
 c('o05','tell me about our applications','overview',"SELECT count(*) FROM applications"),
 c('o06','quick snapshot of the evergreening data','overview',"SELECT count(*) FROM evergreening"),
 c('o07','summary of open critical vulnerabilities','overview',"SELECT count(*) FROM vulnerabilities WHERE status='Open' AND severity='Critical'"),
 c('o08','give me an overview of production servers','overview',"SELECT count(*) FROM servers WHERE environment='Production'"),
 c('o09','describe our failed backups','overview',"SELECT count(*) FROM backups WHERE status='Failed'"),
 c('o10','summery of incidnets','overview',"SELECT count(*) FROM incidents"),
 c('o11','how are we doing on vulnerabilities','overview',"SELECT count(*) FROM vulnerabilities"),
 c('o12','whats the state of our backups','overview',"SELECT count(*) FROM backups"),
 c('o13','any insights on incidents?','overview',"SELECT count(*) FROM incidents"),
 c('o14','give me some stats about the estates','overview',"SELECT count(*) FROM estates"),
 c('o15','summarise windows servers','overview',"SELECT count(*) FROM servers WHERE os='Windows Server'"),
 c('o16','high level picture of P1 incidents','overview',"SELECT count(*) FROM incidents WHERE priority='P1'"),
 // ---- record deep dives ----
 c('r01','bringup any vulnerability we have and gt me a history of it and entire details of it','record',undefined,['VUL-','Timeline']),
 c('r02','tell me everything about host-00042','record',"SELECT server_id,os,environment FROM servers WHERE hostname='host-00042'"),
 c('r03','full details of SRV-00010','record',"SELECT hostname,os FROM servers WHERE server_id='SRV-00010'"),
 c('r04','give me the complete history of server SRV-00100','record',"SELECT count(*) FROM incidents WHERE server_id='SRV-00100'"),
 c('r05','show me all details for incident INC-1012','record',"SELECT status,priority,server_id FROM incidents WHERE incident_id='INC-1012'"),
 c('r06','pick any critical incident and tell me its full story','record',undefined,['INC-','Critical']),
 c('r07','give me one random application with all its info','record',undefined,['APP-']),
 c('r08','details of Payments 1','record',"SELECT application_id FROM applications WHERE application_name='Payments 1'"),
 c('r09','what is the history of VUL-5','record',"SELECT server_id,severity FROM vulnerabilities WHERE vulnerability_id='VUL-5'"),
 c('r10','deep dive into host-00500','record',"SELECT server_id FROM servers WHERE hostname='host-00500'"),
 c('r11','entire details of a failed backup','record',undefined,['Failed']),
 c('r12','tell me about CVE-2025-1500','overview',"SELECT count(*) FROM vulnerabilities WHERE cve='CVE-2025-1500'"),
 // ---- jokes and other non-data asks ----
 c('j01','tell me a joke','joke'),
 c('j02','tell me a joke abou t the vulnerabilities we have','creative',"SELECT count(*) FROM vulnerabilities"),
 c('j03','say something funny about our incidents','creative',"SELECT count(*) FROM incidents"),
 c('j04',['how many servers are in production','tell me a joke'],'joke'),
 c('j05','make me laugh','joke'),
 // ---- must stay normal queries (not hijacked by shapes) ----
 c('q01','summarize incidents by priority','query',"SELECT priority,count(*) FROM incidents GROUP BY 1"),
 c('q02','how many vulnerabilities are there by severity?','query',"SELECT severity,count(*) FROM vulnerabilities GROUP BY 1"),
 c('q03','give me a summary count of servers per environment','query',"SELECT environment,count(*) FROM servers GROUP BY 1"),
 c('q04','what is the os of host-00042','query',undefined,['Windows Server']),
 c('q05','list the first 5 windows servers by server id','query',"SELECT server_id FROM servers WHERE os='Windows Server' ORDER BY server_id LIMIT 5"),
 c('q06','how many incidents does SRV-00100 have','query',"SELECT count(*) FROM incidents WHERE server_id='SRV-00100'"),
 c('q07','describe the incidents table','query',undefined,['incident_id']),
 c('q08','average cvss score of open vulnerabilities','query',"SELECT round(avg(cvss_score),2) FROM vulnerabilities WHERE status='Open'"),
 c('q09','which estate has the most servers','query',"SELECT e.estate_name FROM servers s JOIN applications a USING(application_id) JOIN estates e USING(estate_id) GROUP BY 1 ORDER BY count(*) DESC LIMIT 1"),
 c('q10','total downtime minutes for P1 incidents','query',"SELECT sum(downtime_minutes) FROM incidents WHERE priority='P1'"),
 // ---- conversations: a new self-contained question after another one is not a follow-up ----
 c('m01',['give me a summary of servers we have','bringup any vulnerability we have and gt me a history of it and entire details of it'],'record',undefined,['VUL-']),
 c('m02',['how many incidents are open','give me a summary of backups'],'overview',"SELECT count(*) FROM backups"),
 c('m03',['list the first 5 windows servers by server id','which applications do they belong to?'],'query',undefined,['Inventory 74']),
 c('m04',['how many critical vulnerabilities are open','why?'],'conversation',undefined,['severity','Critical']),
 c('m05',['average cvss score of open vulnerabilities','how did you calculate that'],'conversation',undefined,['averaged']),
 // ---- definitions: answered from the schema, not by a table dump ----
 c('d01','what is evergreening','conversation',"SELECT count(*) FROM evergreening"),
 c('d02','what does cvss score mean','conversation',undefined,['cvss score']),
 c('d03','what is P1','conversation',"SELECT count(*) FROM incidents WHERE priority='P1'"),
 c('d04','whats CVE-2025-1500','overview',"SELECT count(*) FROM vulnerabilities WHERE cve='CVE-2025-1500'"),
 c('d05','what is host-00042','record',"SELECT server_id FROM servers WHERE hostname='host-00042'"),
 // ---- mixed requests: split into parts, each answered with its own shape, merged ----
 c('x01','summarize open incidents and show the top 5 servers with most incidents','multi',"SELECT count(*) FROM incidents WHERE status='Open'"),
 c('x02','give me a summary of backups and tell me a joke about them','multi',"SELECT count(*) FROM backups"),
 c('x03','what is evergreening and how many are blocked','multi',"SELECT count(*) FROM evergreening WHERE evergreen_status='Blocked'"),
 c('x04','how many open vulnerabilities? give me a summary of incidents','multi',["SELECT count(*) FROM vulnerabilities WHERE status='Open'","SELECT count(*) FROM incidents"]),
 c('x05','list the first 5 windows servers by server id and which applications do they belong to','multi',undefined,['SRV-00001','Inventory 74']),
 c('x06','What OS does host-00042 run and which application is it on?','query',undefined,['Windows Server','HR Suite 78']),
 // ---- a value with several possible subjects is asked about, not guessed ----
 {id:'a01',split:'fresh',category:'shape-clarify',turns:['how many are critical'],check:'ambiguous'},
 {id:'a02',split:'fresh',category:'shape-query',turns:['how many are blocked'],check:'scalar',oracle:"SELECT count(*) FROM evergreening WHERE evergreen_status='Blocked'"},
 {id:'a03',split:'fresh',category:'shape-query',turns:['how many incidents are open','how many are critical'],check:'scalar',oracle:"SELECT count(*) FROM incidents WHERE status='Open' AND severity='Critical'"},
 // ---- vague asks: never a raw dump ----
 c('v01','servers','nodump'),
 c('v02','vulnerabilities we have','nodump'),
 c('v03','what about the incidents','nodump'),
 c('v04','backups info','nodump'),
 c('v05','give me something on estates','nodump'),
 c('v06','talk to me about evergreening','nodump'),
];
