# 网站接口封装用处

1. 找词

1.1 vercel.app 监控子域名，拿到新增/上涨的子域名，再从子域名里找词

人工步骤，拿到子域名，打开网站看是干嘛的，看关键词，流量大小。实际看网站在这一步其实没什么用，站的流量和词的流量也不一定相关，站起飞肯定词在起飞，所以只需要从子域名中得到词。

https://sim.3ue.co/api/websiteOrganicLandingPagesV2 子域名落地页，找新的子域名

https://sim.3ue.co/api/websiteOrganicLandingPagesV2/GetTableDrillDown 落地页获取关键词

1.2 sitemap 监控

监控一批游戏站的 sitemap。关键是怎么从页面路径得到关键词，怎么去垃圾，每个站要有专门的清洗方法。

https://xxx/sitemap.xml

1.3 词根找关键词

semrush 关键词魔法工具，similarweb 关键词生成工具

https://sim.3ue.co/api/KeywordGenerator/google/suggest

https://sem.3ue.co/kmtgw/v2/webapi?__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU  
method: "ideas.GetKeywords"
method: "ideas.GetKeywordsSummary"

放一个词根，然后两个工具都找，综合分析流量和KD

2. 验词

从上一步拿到词并简单规则去重、去垃圾词。然后验词

2.1 词看流量，看意图，哥飞 KD 工具

多个工具过滤，给一个比较宽泛的条件，这样可以保证词的数据比较准确

semrush 和 similarWeb 分别查词的流量、KD、CPC

流量大于 1k
哥飞 KD < 50

3. 外链

3.1 根据网站找外链
