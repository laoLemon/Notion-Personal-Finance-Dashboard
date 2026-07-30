/************** 基本配置 **************/
var NOTION_API_KEY = '';   // 请填入Notion Integration Token
var DATABASE_ID = '';      // 请填入账单数据库 ID
var NOTION_API_URL = 'https://api.notion.com/v1/databases/' + DATABASE_ID + '/query';

var HEADERS = {
  'Authorization': 'Bearer ' + NOTION_API_KEY,
  'Content-Type': 'application/json',
  'Notion-Version': '2022-06-28'
};

/************** 内存缓存：避免重复请求 Notion Page 标题 **************/
var pageTitleCache = {};

/**
 * 获取 Notion 页面标题
 */
function getNotionPageTitle(pageId) {
  if (!pageId) return '';
  if (pageTitleCache[pageId]) {
    return pageTitleCache[pageId];
  }

  var url = 'https://api.notion.com/v1/pages/' + pageId;
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: HEADERS,
      muteHttpExceptions: true
    });

    if (res.getResponseCode() !== 200) {
      return '';
    }

    var page = JSON.parse(res.getContentText());
    var props = page.properties || {};

    for (var key in props) {
      var prop = props[key];
      if (prop && prop.type === 'title') {
        var titleArr = prop.title || [];
        var titleText = titleArr.map(function(t) {
          return (t && t.plain_text) ? t.plain_text : '';
        }).join('');
        
        pageTitleCache[pageId] = titleText;
        return titleText;
      }
    }
  } catch (e) {
    console.warn('获取标题失败 ' + pageId + ': ' + e.message);
  }

  return '';
}

/************** 主同步函数 **************/
function fetchNotionDataToSheets() {
  console.log("开始连接 Notion API...");
  var allResults = [];
  var payload = {};

  // 商品明细数据
  var itemRows = [];

  itemRows.push([
    '日期',
    '商品',
    '数量',
    '原始内容'
  ]);

  // 1. 分页拉取 Notion 数据库全部数据
  while (true) {
    var response = UrlFetchApp.fetch(NOTION_API_URL, {
      method: 'post',
      headers: HEADERS,
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var responseCode = response.getResponseCode();
    var responseText = response.getContentText();

    if (responseCode !== 200) {
      throw new Error('Notion 读取失败 (状态码 ' + responseCode + ')：' + responseText);
    }

    var data = JSON.parse(responseText);
    var results = data.results || [];
    allResults = allResults.concat(results);
    
    if (!data.has_more) break;
    payload.start_cursor = data.next_cursor;
  }

  console.log("Notion 数据拉取完毕，总计记录数: " + allResults.length);
  if (allResults.length === 0) {
    console.warn("警告：Notion 返回的数据为空！");
    return;
  }

  // 2. 组装 Sheet 数据
  var dataRows = [];
  dataRows.push([
    '日期',
    '消费类别',
    '来源账户',
    '目标账户',
    '详细内容',
    '价格',
    '收支',

    '现金流金额',
    '收入金额',
    '支出金额',
    '是否现金流',
    '年份',
    '月份',
    '年月',

    '支出性质',
    '支出节奏',
    '额外备注'
  ]);

  for (var i = 0; i < allResults.length; i++) {
    var record = allResults[i];
    var properties = record.properties || {};

    var dateProp = properties['日期'] || {};
    var date = (dateProp.date && dateProp.date.start) ? dateProp.date.start : '';

    var catProp = properties['消费类别'] || {};
    var type = (catProp.select && catProp.select.name) ? catProp.select.name : '未分类';

    var priceProp = properties['价格'] || {};
    var price = (priceProp.number !== undefined && priceProp.number !== null) ? priceProp.number : '';

    var whyProp = properties['支出性质'] || {};
    var why_type = (whyProp.select && whyProp.select.name) ? whyProp.select.name : '未分类';

    var freProp = properties['支出节奏'] || {};
    var fre_type = (freProp.select && freProp.select.name) ? freProp.select.name : '未分类';
    
    var noteProp = properties['额外备注'] || {};
    var noteArr = noteProp.rich_text || [];
    var note = noteArr.map(function(t) {
      return (t && t.plain_text) ? t.plain_text : '';
    }).join('');
      
    var inOutProp = properties['收支'] || {};
    var in_out = (inOutProp.select && inOutProp.select.name) ? inOutProp.select.name : '未分类';

    // =========================
    // BI分析字段
    // =========================

    // 收支映射
    var cashFlowMap = {
      "收入": 1,
      "支出": -1,
      "转账": 0,
      "借出": 0,
      "收回": 0
    };

    var factor = cashFlowMap[in_out] || 0;

    var cashFlowAmount = (price || 0) * factor;

    var incomeAmount = in_out == "收入"
        ? (price || 0)
        : 0;

    var expenseAmount = in_out == "支出"
        ? (price || 0)
        : 0;

    var isCashFlow =
        in_out == "收入" ||
        in_out == "支出";

    var year = "";
    var month = "";
    var yearMonth = "";

    if (date) {
        year = date.substring(0,4);
        month = date.substring(5,7);
        yearMonth = date.substring(0,7);
    }

    var detailProp = properties['详细内容'] || {};
    var detailArr = detailProp.title || [];
    var itemDetail = detailArr.map(function(t) {
      return (t && t.plain_text) ? t.plain_text : '';
    }).join('');

    // =========================
    // 商品明细拆分
    // =========================

    if (itemDetail) {

      var items = itemDetail.split("，");

      items.forEach(function(item){

        item = item.trim();

        if (!item) return;


        var qty = 1;
        var name = item;


        if (item.indexOf("*") > -1) {

          var parts = item.split("*");

          qty = Number(parts[0]);

          name = parts.slice(1).join("*");

        }


        itemRows.push([
          date,
          name,
          qty,
          item
        ]);

      });

    }

    var sourceName = '';
    var sourceProp = properties['来源账户'] || {};
    var sourceRelation = sourceProp.relation || [];
    if (sourceRelation.length > 0 && sourceRelation[0] && sourceRelation[0].id) {
      sourceName = getNotionPageTitle(sourceRelation[0].id);
    }

    var targetName = '';
    var targetProp = properties['目标账户'] || {};
    var targetRelation = targetProp.relation || [];
    if (targetRelation.length > 0 && targetRelation[0] && targetRelation[0].id) {
      targetName = getNotionPageTitle(targetRelation[0].id);
    }

    dataRows.push([
      date,
      type,
      sourceName,
      targetName,
      itemDetail,
      price,
      in_out,

      cashFlowAmount,
      incomeAmount,
      expenseAmount,
      isCashFlow,
      year,
      month,
      yearMonth,

      why_type,
      fre_type,
      note
    ]);
  }

  // 3. 高效更新 Google Sheets（不再删表，而是清空旧内容并直接覆盖，秒级完成）
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('总账单');
  
  if (!sheet) {
    sheet = ss.insertSheet('总账单');
  } else {
    sheet.clearContents(); // 只清空单元格内容，保留工作表本身、背景色和表格框架
  }

  if (dataRows.length > 0) {
    sheet.getRange(1, 1, dataRows.length, dataRows[0].length).setValues(dataRows);
  }

  if (dataRows.length > 1) {
    sheet.getRange(2, 1, dataRows.length - 1, 1).setNumberFormat('yyyy-mm-dd');
  }
  // =========================
  // 更新商品明细 Sheet
  // =========================

  var itemSheet = ss.getSheetByName('商品明细');


  if (!itemSheet) {

    itemSheet = ss.insertSheet('商品明细');

  } else {

    itemSheet.clearContents();

  }


  if (itemRows.length > 0) {

    itemSheet
      .getRange(
        1,
        1,
        itemRows.length,
        itemRows[0].length
      )
      .setValues(itemRows);

  }

  console.log("数据同步成功！共更新 " + (dataRows.length - 1) + " 行记录。");
}
