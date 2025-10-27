import { Table } from "console-table-printer";
import UpdateManager from 'stdout-update';

const manager = UpdateManager.getInstance();
manager.hook();

let counter = 0;

setInterval(() => {
    const p = new Table({
        title: "Market List",
        columns: [
            { name: "#", alignment: "left" },
            { name: "Name", alignment: "right", color: "green" },
            { name: "Balance", alignment: "right", color: "white" },
        ],
    });

    const data = [
        { "#": counter, Name: "Alice", Balance: (Math.random() * 1000).toFixed(2) },
        { "#": counter, Name: "Bob", Balance: (Math.random() * 1000).toFixed(2) },
    ]
    p.addRows(data);

    manager.update(p.render().split("\n")); // 💥 原地刷新
    counter++;
}, 500);

process.on('SIGINT', () => {
    manager.unhook(false);
    process.exit(0);
});
