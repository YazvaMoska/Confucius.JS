/**
 * Created by BronzeBee on 09.04.2016.
 */

/**
 * Подключем модули
 * @type {exports|module.exports}
 */
var fs = require("fs");
var winston = require("winston");
var moment = require("moment");
var SteamUser = require("steam-user");
var SteamCommunityContainer = require("steamcommunity");
var SteamTotp = require("steam-totp");
var TradeOfferManager = require("steam-tradeoffer-manager");
var mongodb = require("mongodb");
var MongoClient = mongodb.MongoClient;
var crypto = require("crypto");
var async = require("async");


/**
 * База данных
 */
var db;

/**
 * Авторизирован ли бот
 * @type {boolean}
 */
var LOGGED_IN = false;

/**
 * Выводит все необходимое в консоль и в файл
 */
var logger = createLogger();

/**
 * Конфигурация бота
 */
var config = JSON.parse(fs.readFileSync("./config.json", "utf-8"));

/**
 * Инициализируем клиент Steam и менеджер обменов
 * @type {SteamUser|exports|module.exports}
 */
var steamClient = new SteamUser();
var tradeManager = new TradeOfferManager({
    "steam": steamClient,
    "domain": "dota2bets.ru",
    "language": "en"
});
var steamCommunity = new SteamCommunityContainer();

/**
 * Объект, несущий информацию о текущей игре
 */
var currentGame;

/**
 * Запускаем бота
 */
main();

function main() {
    logger.info("********** Конфуций v2.01 **********");
    logger.info("Установка соединения с базой данных");
    connectToDB(function (database) {
        db = database;
        auth();
    });
}

/**
 * Авторизируемся через Steam
 */
function auth() {
    var logOnOptions = config["logOnOptions"];
    logger.info("Установлен пользователь: " + logOnOptions.accountName);
    logOnOptions.twoFactorCode = SteamTotp.generateAuthCode(logOnOptions.sharedSecret);
    logger.info("Авторизация");
    steamClient.setSentry(fs.readFileSync("./sentry.txt"));

    /**
     * В случае, если через 5 секунд бот по каким-либо
     * причинам все еще не залогинен, выключаемся.
     * (мера предосторожности)
     */
    setTimeout(function () {
        if (!LOGGED_IN) {
            logger.error("Авторизация не удалась");
            terminate();
        }
    }, 5000);

    steamClient.logOn(logOnOptions);
}


/**
 * Коннектим базу данных
 */
function connectToDB(callback) {
    MongoClient.connect(config.mongodb.url, function (err, db) {
        if (err) {
            logger.error("Не удалось соединиться с базой данных:");
            logger.error(err.stack || err);
            terminate();
        } else {
            logger.info("Соединение с базой данных установлено");
            callback(db);
        }
    });
}

/**
 * Уведомляем царей об успешной авторизации
 */
steamClient.on('loggedOn', function () {
    LOGGED_IN = true;
    steamClient.setPersona(SteamUser.Steam.EPersonaState.LookingToTrade);
    notifyAdmins(moment().format("HH:mm:ss") + " - Авторизирован.", true);
});

/**
 * Обрабатываем сообщения в чате
 */
steamCommunity.on('chatMessage', function (sender, text) {
    text = text.trim();
    if (config.admins.indexOf(sender.getSteamID64()) >= 0 && text.charAt(0) == "/") {
        var args = text.replace("/", "").split(" ");
        var command = args[0];
        args.splice(0, 1);
        executeCommand(command, args, sender.getSteamID64());
    }
});


/**
 * Генерируем API key и запускаем получение
 * новых кодов подтверждения
 */
steamClient.on('webSession', function (sessionID, cookies) {
    tradeManager.setCookies(cookies, function (err) {
        if (err) {
            logger.error("Не удалось получить API key");
            logger.error(err.stack || err);
            terminate();
            return;
        }
        logger.info("Получен API key: " + tradeManager.apiKey);
    });
    steamCommunity.setCookies(cookies);
    steamCommunity.chatLogon();
    steamCommunity.startConfirmationChecker(30000, config["identitySecret"]);
});

/**
 * Обрабатываем обмен
 */
tradeManager.on('newOffer', function (offer) {
    if (config.trading) {

    }
    logger.info("Получено предложение об обмене #" + offer.id + " от " + offer.partner);
    notifyAdmins("Получено предложение об обмене #" + offer.id + " от " + offer.partner.getSteam3RenderedID());
    // console.log(offer);
    //   console.log("*********************");
    //   console.log(offer.partner);
    /* offer.accept(function (err) {
     if (err) {
     logger.error("Ошибка во время принятия обмена");
     logger.error(err.message);
     } else {
     steamCommunity.checkConfirmations();
     logger.info("Обмен принят");
     notifyAdmins("Обмен принят");
     }
     });*/
});

/**
 * Отправляет сообщение всем царям
 * @param msg текст сообщения
 * @param echo логгировать ли сообщение [optional]
 */
function notifyAdmins(msg, echo) {
    if (echo)
        logger.info(msg);
    config.admins.forEach(function (admin) {
        steamClient.chatMessage(admin, msg);
    });
}

/**
 * Создаем логгер.
 * Последний файл вывода носит имя latest.log.
 * Предыдущий файл вывода переименовывается по
 * заранее записанной дате.
 */
function createLogger() {
    function formatter(args) {
        var date = moment().format("HH:mm:ss");
        var logMessage = "[" + date + " " + args.level.toUpperCase() + "]: " + args.message;
        return logMessage;
    }

    var dateString = moment().format("YYYY-MM-DD HH-mm-ss");
    if (fs.existsSync("./logs/confucius/logdata.json")) {
        var logData = JSON.parse(fs.readFileSync("./logs/confucius/logdata.json", "utf-8"));
        if (fs.existsSync("./logs/confucius/latest.log")) {
            fs.rename("./logs/confucius/latest.log", "./logs/confucius/" + logData["last_date"] + ".log", function () {
            });
        }
        logData["last_date"] = dateString;
        fs.writeFileSync("./logs/confucius/logdata.json", JSON.stringify(logData), "utf-8");
    } else {
        var logData = {"last_date": dateString};
        fs.writeFileSync("./logs/confucius/logdata.json", JSON.stringify(logData), "utf-8");
    }
    var logger = new winston.Logger({
        json: false,
        transports: [
            new (winston.transports.Console)({
                handleExceptions: false,
                json: false,
                formatter: formatter
            }),
            new (winston.transports.File)({
                filename: './logs/confucius/latest.log',
                handleExceptions: false,
                json: false,
                formatter: formatter
            })
        ]
    });
    return logger;
}

/**
 * Выходим из Steam и завершаем процесс
 * @param printf функция логгинга [optional]
 */
function terminate(printf) {
    if (printf)
        printf("Закрытие соединения и завершение работы");
    else
        logger.info("Закрытие соединения и завершение работы");
    if (LOGGED_IN) {
        steamCommunity.chatLogoff()
        steamClient.logOff();
    }
    if (db)
        db.close();
    setTimeout(function () {
        process.exit(0);
    }, 2000);
}

/**
 * Класс, описывающий данные игры
 * @param id номер игры
 * @constructor
 */
function Game(id) {
    this.id = id;
    this.gameTimer = -1;
    this.currentBank = 0;
    this.items = [];
    this.float = Math.random();
    this.hash = crypto.createHash('md5').update(this.float).digest('hex');
    this.timerID = -1;
    this.ownerSortedItems = {};
}

Game.prototype.sortItemsByOwner = function (items) {
    var ownerSortedItems = {};
    async.forEachOfSeries(items, function (item, index, callback) {
        if (ownerSortedItems[item.owner]) {
            ownerSortedItems[item.owner].push(item);
        } else {
            ownerSortedItems[item.owner] = [];
            ownerSortedItems[item.owner].push(item);
        }
        callback();
    }, function () {
        return ownerSortedItems;
    });
}

/**
 * Если игра была прервана, возобновляем её
 * Все значения должны браться из базы данных
 * @param timer время до конца игры (в секундах)
 * @param bank полная стоимость предметов в игре
 * @param items все предметы в текущей игре
 * @param float число раунда
 * @param hash хэш раунда
 */
Game.prototype.resume = function (timer, bank, items, float, hash) {
    this.gameTimer = timer;
    this.currentBank = bank;
    this.items = items;
    this.float = float;
    this.hash = hash;
    this.ownerSortedItems = this.sortItemsByOwner(this.items);
    if (this.gameTimer > 0) {
        this.start();
    }
}

/**
 * Запускаем отсчет до конца игры
 */
Game.prototype.start = function () {
    this.timerID = setInterval(function () {
        this.gameTimer--;
        //socket.emit("event.main_timer", this.gameTimer);
        if (this.gameTimer == 0) {
            clearInterval(this.timerID);
        }
    }, 1000);
}

Game.prototype.selectWinner = function () {

}


/**
 * Выполняет соответствующую команду
 * @param command название команды
 * @param args аргументы
 * @param sender SteamID отправителя
 */
function executeCommand(command, args, sender) {
    switch (command) {
        case "terminate":
        {
            notifyAdmins("Пользователь " + sender + " использовал команду terminate");
            var msg = "الله أكبر";
            steamClient.chatMessage(sender, msg);
            steamClient.chatMessage(sender, "BOOM");
            setTimeout(function () {
                terminate();
            }, 2000);
            break;
        }
        case "help":
        {
            if (args.length <= 0) {
                steamClient.chatMessage(sender, "тип тут помощь ок");
            } else {
                switch (args[0]) {
                    case "terminate":
                    {
                        steamClient.chatMessage(sender, "برنامج انفجارات في سبيل الله والإسلام");
                        break;
                    }
                    default:
                    {
                        steamClient.chatMessage(sender, "Дополнительная информация об этой команде отсутствует");
                    }
                }
            }
            break;
        }
        default:
        {
            steamClient.chatMessage(sender, "Неизвестная команда");
        }
    }

}

/**
 * Обрабатываем непредвиденные ошибки
 * чтобы безопасно завершить работу
 */
process.on('uncaughtException', function (err) {
    var printf = logger ? logger.error : console.log;
    printf("Непредвиденная ошибка:");
    printf(err.stack || err);
    printf("Приложение будет закрыто");
    terminate(printf);
});