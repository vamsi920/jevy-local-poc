// Prints how chart wording is separated from the data question.
import {chartRequest} from '../backend/chart.js';
for(const q of process.argv.slice(2))console.log(JSON.stringify(chartRequest(q)));
