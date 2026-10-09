// Chart battery: varied chart requests (explicit types, typos, joins, time series, two dimensions,
// histograms, chart-only follow-ups, auto charts, scalars and unanswerable requests).
// Oracles are independent SQL: first column = x label, (optional) second = series, last = value.
import type {ChartType} from '../backend/chart.js';
export type ChartCase={id:string;category:string;turns:string[];types?:ChartType[];oracle?:string;points?:number;noChart?:boolean;status?:'answered'|'not-answered';dashboard?:boolean};
const c=(id:string,category:string,turns:string|string[],types?:ChartType[],oracle?:string,extra:Partial<ChartCase>={}):ChartCase=>({id,category,turns:Array.isArray(turns)?turns:[turns],types,oracle,...extra});
const AS_OF='(SELECT as_of FROM dataset_info)';
const JOIN_EST='JOIN servers s USING(server_id) JOIN applications a USING(application_id) JOIN estates e USING(estate_id)';
const BARS:ChartType[]=['column','bar'];
// No type requested: the chooser may pick bars or, for a small breakdown of a whole, a donut.
const AUTO:ChartType[]=['column','bar','donut'];
export const chartCases:ChartCase[]=[
 // ---- single category, explicit types ----
 c('c01','category','pie chart of servers by os',['pie'],'SELECT os,count(*) FROM servers GROUP BY 1'),
 c('c02','category','bar chart of open vulnerabilities by severity',BARS,"SELECT severity,count(*) FROM vulnerabilities WHERE status='Open' GROUP BY 1"),
 c('c03','category','donut of backup status',['donut'],'SELECT status,count(*) FROM backups GROUP BY 1'),
 c('c04','category','horizontal bar chart of servers per datacenter',['bar'],'SELECT datacenter,count(*) FROM servers GROUP BY 1'),
 c('c05','category','chart incidents by category',AUTO,'SELECT category,count(*) FROM incidents GROUP BY 1'),
 c('c06','category','visualize servers by environment',AUTO,'SELECT environment,count(*) FROM servers GROUP BY 1'),
 c('c07','category','graph applications by criticality',AUTO,'SELECT criticality,count(*) FROM applications GROUP BY 1'),
 c('c08','category','plot the evergreening status breakdown',AUTO,'SELECT evergreen_status,count(*) FROM evergreening GROUP BY 1'),
 c('c09','category','show me a column chart of incidents per assigned team',AUTO,'SELECT assigned_team,count(*) FROM incidents GROUP BY 1'),
 c('c10','category','pie of incident priority',['pie'],'SELECT priority,count(*) FROM incidents GROUP BY 1'),
 // ---- measures ----
 c('c11','measure','chart average downtime by priority',BARS,'SELECT priority,avg(downtime_minutes) FROM incidents GROUP BY 1'),
 c('c12','measure','bar chart of total disk gb by datacenter',BARS,'SELECT datacenter,sum(disk_gb) FROM servers GROUP BY 1'),
 c('c13','measure','plot average cvss score by severity',BARS,'SELECT severity,avg(cvss_score) FROM vulnerabilities GROUP BY 1'),
 c('c14','measure','chart average backup size by backup type',BARS,'SELECT backup_type,avg(size_gb) FROM backups GROUP BY 1'),
 c('c15','measure','graph max memory gb per os',BARS,'SELECT os,max(memory_gb) FROM servers GROUP BY 1'),
 c('c16','measure','visualize average estimated cost by risk level',BARS,'SELECT risk_level,avg(estimated_cost) FROM evergreening GROUP BY 1'),
 // ---- time series ----
 c('c17','time','plot incidents per month',['area','line'],"SELECT date_trunc('month',created_date)::DATE,count(*) FROM incidents GROUP BY 1"),
 c('c18','time','line chart of vulnerabilities discovered per week',['line'],"SELECT date_trunc('week',discovered_date)::DATE,count(*) FROM vulnerabilities GROUP BY 1"),
 c('c19','time','chart backups started per month',['area','line','column'],"SELECT date_trunc('month',started_at)::DATE,count(*) FROM backups GROUP BY 1"),
 c('c20','time','visualize the trend of incidents by month',['area','line'],"SELECT date_trunc('month',created_date)::DATE,count(*) FROM incidents GROUP BY 1"),
 c('c21','time','area chart of servers created per month',['area'],"SELECT date_trunc('month',created_date)::DATE,count(*) FROM servers GROUP BY 1"),
 c('c22','time','plot major incidents per month',['area','line'],"SELECT date_trunc('month',created_date)::DATE,count(*) FROM incidents WHERE major_incident GROUP BY 1"),
 // ---- joins across tables ----
 c('c23','join','bar chart of open critical vulnerabilities per estate',BARS,`SELECT e.estate_name,count(*) FROM vulnerabilities v ${JOIN_EST} WHERE v.status='Open' AND v.severity='Critical' GROUP BY 1`),
 c('c24','join','chart failed backups by estate',AUTO,`SELECT e.estate_name,count(*) FROM backups b ${JOIN_EST} WHERE b.status='Failed' GROUP BY 1`),
 c('c25','join','plot incidents by server environment',AUTO,'SELECT s.environment,count(*) FROM incidents i JOIN servers s USING(server_id) GROUP BY 1'),
 c('c26','join','visualize vulnerabilities by server os',AUTO,'SELECT s.os,count(*) FROM vulnerabilities v JOIN servers s USING(server_id) GROUP BY 1'),
 c('c27','join','show a chart of the top 10 applications by incident count',BARS,'SELECT a.application_name,count(*) FROM incidents i JOIN servers s USING(server_id) JOIN applications a USING(application_id) GROUP BY 1 ORDER BY 2 DESC LIMIT 10',{points:10}),
 c('c28','join','chart the top 5 datacenters by number of open incidents',BARS,"SELECT s.datacenter,count(*) FROM incidents i JOIN servers s USING(server_id) WHERE i.status='Open' GROUP BY 1 ORDER BY 2 DESC LIMIT 5"),
 c('c29','join','graph servers by estate',AUTO,'SELECT e.estate_name,count(*) FROM servers s JOIN applications a USING(application_id) JOIN estates e USING(estate_id) GROUP BY 1'),
 c('c30','join','pie chart of P1 incidents by country',['pie'],"SELECT s.country,count(*) FROM incidents i JOIN servers s USING(server_id) WHERE i.priority='P1' GROUP BY 1"),
 // ---- two dimensions ----
 c('c31','two-dim','stacked bar chart of servers by os and environment',['stacked'],'SELECT environment,os,count(*) FROM servers GROUP BY 1,2'),
 c('c32','two-dim','chart vulnerabilities by severity and status',['stacked','grouped'],'SELECT severity,status,count(*) FROM vulnerabilities GROUP BY 1,2'),
 c('c33','two-dim','grouped bar chart of backups by status and backup type',['grouped'],'SELECT status,backup_type,count(*) FROM backups GROUP BY 1,2'),
 c('c34','two-dim','stacked chart of incidents by priority and status',['stacked'],'SELECT priority,status,count(*) FROM incidents GROUP BY 1,2'),
 // ---- distributions ----
 c('c35','histogram','histogram of cpu cores',['column'],'SELECT cpu_cores::VARCHAR,count(*) FROM servers GROUP BY 1'),
 c('c36','histogram','create a histogram of memory gb',['column'],'SELECT memory_gb::VARCHAR,count(*) FROM servers GROUP BY 1'),
 c('c37','histogram','chart the retention days distribution',['column','bar','kpi'],'SELECT retention_days::VARCHAR,count(*) FROM backups GROUP BY 1'),
 // ---- typos ----
 c('c38','typo','pie chrt of servrs by enviroment',['pie'],'SELECT environment,count(*) FROM servers GROUP BY 1'),
 c('c39','typo','bar grpah of vulnerabilites by severty',BARS,'SELECT severity,count(*) FROM vulnerabilities GROUP BY 1'),
 c('c40','typo','plot incidnets per month',['area','line'],"SELECT date_trunc('month',created_date)::DATE,count(*) FROM incidents GROUP BY 1"),
 // ---- chart-only follow-ups ----
 c('c41','followup',['servers by os','make that a pie chart'],['pie'],'SELECT os,count(*) FROM servers GROUP BY 1'),
 c('c42','followup',['open vulnerabilities by severity','show it as a bar chart'],BARS,"SELECT severity,count(*) FROM vulnerabilities WHERE status='Open' GROUP BY 1"),
 c('c43','followup',['incidents per month','chart it'],['area','line'],"SELECT date_trunc('month',created_date)::DATE,count(*) FROM incidents GROUP BY 1"),
 c('c44','followup',['how many backups by status','turn this into a donut'],['donut'],'SELECT status,count(*) FROM backups GROUP BY 1'),
 c('c45','followup',['servers by datacenter','now as a horizontal bar chart'],['bar'],'SELECT datacenter,count(*) FROM servers GROUP BY 1'),
 c('c46','followup',['chart average downtime by priority','by environment'],BARS,'SELECT s.environment,avg(i.downtime_minutes) FROM incidents i JOIN servers s USING(server_id) GROUP BY 1'),
 c('c47','followup',['pie chart of servers by os','only production'],undefined,"SELECT os,count(*) FROM servers WHERE environment='Production' GROUP BY 1"),
 // ---- automatic charts and figures ----
 c('c48','auto','how many servers per country',AUTO,'SELECT country,count(*) FROM servers GROUP BY 1'),
 c('c49','auto','incidents per month',['area','line'],"SELECT date_trunc('month',created_date)::DATE,count(*) FROM incidents GROUP BY 1"),
 c('c50','auto','how many servers are there',undefined,undefined,{noChart:true}),
 c('c51','figure','chart the total number of servers',['kpi'],'SELECT count(*) FROM servers'),
 c('c52','figure','plot the average cvss score',['kpi'],'SELECT avg(cvss_score) FROM vulnerabilities'),
 // ---- several results in one chart ----
 c('c53','multi','chart counts of open critical vulnerabilities, P1 incidents and failed backups',['column'],"SELECT count(*) FROM vulnerabilities WHERE status='Open' AND severity='Critical' UNION ALL SELECT count(*) FROM incidents WHERE priority='P1' UNION ALL SELECT count(*) FROM backups WHERE status='Failed'",{points:3}),
 c('c54','multi','compare servers in production vs staging in a chart',BARS,"SELECT environment,count(*) FROM servers WHERE environment IN ('Production','Staging') GROUP BY 1"),
 // ---- many categories, booleans ----
 c('c55','many','bar chart of servers by application',['bar'],'SELECT a.application_name,count(*) FROM servers s JOIN applications a USING(application_id) GROUP BY 1'),
 c('c56','many','chart vulnerabilities by package name',AUTO,'SELECT package_name,count(*) FROM vulnerabilities GROUP BY 1'),
 c('c57','boolean','pie chart of servers by virtualized',['pie'],'SELECT virtualized,count(*) FROM servers GROUP BY 1'),
 c('c58','boolean','donut chart of incidents by sla breached',['donut'],'SELECT sla_breached,count(*) FROM incidents GROUP BY 1'),
 // ---- cannot or should not chart ----
 c('c59','unanswerable','plot revenue by month',undefined,undefined,{noChart:true,status:'not-answered'}),
 c('c60','unanswerable','make a chart',undefined,undefined,{noChart:true,status:'not-answered'}),
 // ---- more phrasing variety ----
 c('c61','phrasing','can you draw me a graph showing incidents by severity',AUTO,'SELECT severity,count(*) FROM incidents GROUP BY 1'),
 c('c62','phrasing','i want to see a pie chart for applications by business unit',['pie'],'SELECT business_unit,count(*) FROM applications GROUP BY 1'),
 c('c63','phrasing','visualise backups per destination',AUTO,'SELECT destination,count(*) FROM backups GROUP BY 1'),
 c('c64','phrasing','give me a line graph of backups per month',['line'],"SELECT date_trunc('month',started_at)::DATE,count(*) FROM backups GROUP BY 1"),
 c('c65','phrasing','servers by region as a donut chart',['donut'],'SELECT region,count(*) FROM servers GROUP BY 1'),
 c('c67','time-split','plot incidents per month by priority',['line'],"SELECT date_trunc('month',created_date)::DATE,priority,count(*) FROM incidents GROUP BY 1,2"),
 c('c68','time-split','chart open incidents per week by severity',['line'],"SELECT date_trunc('week',created_date)::DATE,severity,count(*) FROM incidents WHERE status='Open' GROUP BY 1,2"),
 c('c69','time-split','monthly vulnerabilities discovered by severity as a line chart',['line'],"SELECT date_trunc('month',discovered_date)::DATE,severity,count(*) FROM vulnerabilities GROUP BY 1,2"),
 // ---- the question's intent picks the form ----
 c('v01','variety','what share of servers are in each environment? chart it',['donut'],'SELECT environment,count(*) FROM servers GROUP BY 1'),
 c('v02','variety','visualize the proportion of incidents by category',['donut','treemap'],'SELECT category,count(*) FROM incidents GROUP BY 1'),
 c('v03','variety','chart the top 8 assigned teams by number of incidents',['bar'],'SELECT assigned_team,count(*) FROM incidents GROUP BY 1 ORDER BY 2 DESC LIMIT 8',{points:8}),
 c('v04','variety','compare backups by status and backup type in a chart',['grouped'],'SELECT status,backup_type,count(*) FROM backups GROUP BY 1,2'),
 c('v05','variety','chart the percentage split of vulnerabilities by severity and status',['percent'],'SELECT severity,status,count(*) FROM vulnerabilities GROUP BY 1,2'),
 c('v06','variety','chart incidents by assigned team and priority',['heatmap'],'SELECT assigned_team,priority,count(*) FROM incidents GROUP BY 1,2'),
 c('v07','variety','plot the share of incidents per month by priority',['stackedarea'],"SELECT date_trunc('month',created_date)::DATE,priority,count(*) FROM incidents GROUP BY 1,2"),
 c('v08','variety','cumulative incidents per month',['line']),
 c('v09','variety','what percentage of servers are unsupported? show a chart',['gauge']),
 c('v10','variety','treemap of servers by application',['treemap'],'SELECT a.application_name,count(*) FROM servers s JOIN applications a USING(application_id) GROUP BY 1'),
 c('v11','variety','radial chart of servers by datacenter',['radial'],'SELECT datacenter,count(*) FROM servers GROUP BY 1'),
 c('v12','variety','heatmap of servers by os and environment',['heatmap'],'SELECT environment,os,count(*) FROM servers GROUP BY 1,2'),
 c('v13','variety','100% stacked chart of backups by status and destination',['percent'],'SELECT status,destination,count(*) FROM backups GROUP BY 1,2'),
 c('v14','variety','stacked area chart of vulnerabilities discovered per month by severity',['stackedarea'],"SELECT date_trunc('month',discovered_date)::DATE,severity,count(*) FROM vulnerabilities GROUP BY 1,2"),
 c('v15','variety','pie chart of average cvss score by severity',['column','bar'],'SELECT severity,avg(cvss_score) FROM vulnerabilities GROUP BY 1'),
 // ---- summaries become dashboards: several charts, varied forms ----
 c('d01','dashboard','give me a summary of servers we have',undefined,undefined,{dashboard:true}),
 c('d02','dashboard','summarize incidents',undefined,undefined,{dashboard:true}),
 c('d03','dashboard','overview of backups',undefined,undefined,{dashboard:true}),
 c('d04','dashboard','tell me about our applications',undefined,undefined,{dashboard:true}),
 c('c66','phrasing','how are open incidents distributed across priorities? show a chart',AUTO,"SELECT priority,count(*) FROM incidents WHERE status='Open' GROUP BY 1"),
];
export const chartAsOf=AS_OF;
