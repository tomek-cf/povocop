"use strict";

const express = require('express')
const app = express()
const port = 9000;
const cors = require('cors')

const TokenUtils = require('./utils/tokenUtils')
const DBUtils = require('./utils/dbUtils')
const DataUtils = require('./utils/dataUtils')
const ResultUtils = require('./utils/resultUtils')
const bodyParser = require('body-parser')
const WhichBrowser = require('which-browser');
const server = require('http').Server(app);
const io = require('socket.io')(server);
const auth = require('./utils/authUtils');

const socketEventsEmitter = require('./utils/socketEventEmitter')
let STATE = {
    redundancyFactors: {},
    config : {},
    apps : [],
    socketMap : [],
    pendingResults : {},
    usersOnline: {}
}
console.log(`Frontend script available at: \n http://IPADDR:${port}/scripts/PovocopScript.js`)
auth.setCredentials();
DBUtils.init().then(() => {
    DataUtils.init(STATE).then(initSocketsAndHTTP);
});


app.use(bodyParser.json({limit: '50mb', extended: true, parameterLimit:500000}));

app.use(express.static('public'))
app.use(cors({credentials: true, origin: true}))

app.post('/data/:appname',  (req, res) => {
    const appName = req.params.appname;
    req.body.data.map(function(val){
        val.appName=appName;
        return val;
    })
    DBUtils.insertInputData(req.body.data,appName,function(response){
        DataUtils.cacheMoreInputData(STATE,appName,0);
        res.json(response)
    });
});
app.delete('/data/:appname',  (req, res) => {
    const appName = req.params.appname;
    DBUtils.deleteInputData(appName,function(response){
        res.json({})
    });
});
app.post('/config/:appname', auth.basicAuth, (req, res) => {
    const appName = req.params.appname;
    req.body.data.appName = appName;
    const redundancyFactor = req.body.data.redundancyFactor
    req.body.data.redundancyFactor = redundancyFactor !== "" ? parseInt(redundancyFactor) :0;
    DBUtils.insertConfigData(req.body.data,function(response){
        newConfigCallback(response);
        res.json(response)
    });
});
app.get('/config/:appname', auth.basicAuth, (req, res) => {
    const appName = req.params.appname;
    DBUtils.getConfigData(appName,function(response){
        res.send(response)
    });
});
app.get('/data/:appname',  auth.basicAuth, (req, res) => {
    const appName = req.params.appname;
    DBUtils.getInputData(appName,function(response){
        res.send({inputData: response})
    },{getNotAssigned : true});
});
app.get('/manager/config/:appname',  auth.basicAuth, (req, res) => {
    const appName = req.params.appname;
    res.sendFile(process.cwd()+'/views/computationConfig.html')
});
app.get('/manager/data/:appname', auth.basicAuth, (req, res) => {
    const appName = req.params.appname;
    res.sendFile(process.cwd()+'/views/inputDataView.html')
});
app.get('/results/:appname', auth.basicAuth, (req, res) => {
    const appName = req.params.appname;
    DBUtils.getResults(appName,function(results){
        res.send(results)
    })
})
function newConfigCallback(response){
    const appName = response.appName
    if(!STATE.apps.includes(appName)){
        STATE.apps.push(appName);
        STATE.pendingResults[appName] = []
        const nsp = io.of(`/${appName}`);
        nsp.on('connection', socketHandler)
    }
    STATE.redundancyFactors[appName]=parseInt(response.redundancyFactor);
    delete response['redundancyFactor'];
    STATE.config[appName] = STATE.config[appName] || {}
    const lastConfigProvidedResult = STATE.config[appName]['provideLastResultInConfig'];
    Object.keys(response).forEach(function(key){
        STATE.config[appName][key] = response[key];
    })
    const provideResult = STATE.config[appName]['provideLastResultInConfig'];
    STATE.config[appName]['lastApprovedResult'] = provideResult ? STATE.config[appName]['lastApprovedResult'] : {} ;
    if(!lastConfigProvidedResult && provideResult){
        DBUtils.getLastApprovedResult(appName,function(lastResult){
            STATE.config[appName]['lastApprovedResult'] = lastResult;
            socketEventsEmitter.emit('newConfig'+appName);
        })
    }
    else{
        socketEventsEmitter.emit('newConfig'+appName);
    }
}
function initSocketsAndHTTP(configuredState){
    STATE = configuredState;
    server.listen(port, () => {
        console.log(`Scheduler listening on port ${port}!`)
    })

    STATE.apps = [];

    for(let app in STATE.config){
        const nsp = io.of('/'+app);
        STATE.apps.push(app)
        STATE.socketMap[app]=[]
        nsp.on('connection', socketHandler)
    }
    const nsp = io.of('/random');
    nsp.on('connection', socketHandler)
    // io.on('connection', socketHandler)

}
function isUserAlreadyConnected(decodedToken,STATE,socket){
    if(typeof STATE.usersOnline[decodedToken.uuid] !== 'undefined'){
        socket.disconnect();
        return true;
    }else{
        STATE.usersOnline[decodedToken.uuid] = socket.id;
        return false;
    }
}
function socketHandler(socket){
    socket.ip = socket.handshake.address
        + Math.random(); //for debug only
    socket.results = [];
    socket.times = [];
    socket.bestTime = 9999999;
    console.log('New connection from ' + socket.ip);
    const nsp = this;
    socket.appName = nsp.name !== '/random' ? nsp.name.split('/').join('') : STATE.apps[Math.floor((Math.random() * STATE.apps.length))]
    STATE.socketMap[socket.appName] = STATE.socketMap[socket.appName] ? STATE.socketMap[socket.appName] : [];
    if(STATE.socketMap[socket.appName].find(function(tempSocket){
        return tempSocket.id===socket.id
    })){
        socket.disconnect();
    }
    STATE.socketMap[socket.appName].push(socket)
    console.log(socket.appName)
    let resultsCount = 0
    let lastResultsCount = 0
    let decodedToken=TokenUtils.validateToken(socket.handshake.query.povocoptoken);
    //for debugging - remove it later!


    const isTokenInRequest = decodedToken;
    const isUsernameInRequest = isTokenInRequest && decodedToken.povocopusername;
    socketEventsEmitter.on('newConfig'+socket.appName,() =>{
        socket.emit('computationConfig', STATE.config[socket.appName]);
    })
    socket.on('newNumOfCpus', newNumOfCpus =>{
        const tokenToSend = TokenUtils.createToken(socket,newNumOfCpus,socket.povocopData)
        socket.emit('token', tokenToSend);
    })
    if(!isTokenInRequest){
        socket.emit('computeNumOfCpu', {});
        socket.once('numOfCpus', (numOfCpus) => {
            const tokenToSend = TokenUtils.createToken(socket,numOfCpus)
            if(isUserAlreadyConnected(socket.povocopData,STATE,socket)){return;}
            socket.inputData = new Array(numOfCpus);
            socket.times = new Array(numOfCpus);
            socket.emit('token', tokenToSend);
            socket.emit('computationConfig', STATE.config[socket.appName]);
            ResultUtils.sendPendingVerificationsToAllWorkers(STATE,socket,numOfCpus)
            if(STATE.config[socket.appName].includesInputData){
                DataUtils.sendInputDataToWorkers(STATE,socket,numOfCpus)
            }

        });
    }else if(!isUsernameInRequest && socket.handshake.query.povocopusername){
        if(isUserAlreadyConnected(decodedToken,STATE,socket)){return;}
        const tokenToSend = TokenUtils.createToken(socket,decodedToken.numOfCpus,decodedToken)
        socket.inputData = new Array(decodedToken.numOfCpus);
        socket.times = new Array(decodedToken.numOfCpus);
        socket.emit('token', tokenToSend)
        socket.emit('computationConfig', STATE.config[socket.appName]);
        ResultUtils.sendPendingVerificationsToAllWorkers(STATE,socket,decodedToken.numOfCpus)
        if(STATE.config[socket.appName].includesInputData){
            DataUtils.sendInputDataToWorkers(STATE,socket,decodedToken.numOfCpus)
        }
    }else{
        if(isUserAlreadyConnected(decodedToken,STATE,socket)){return;}
        socket.povocopData=decodedToken;
        socket.inputData = new Array(decodedToken.numOfCpus)
        socket.times = new Array(decodedToken.numOfCpus);
        socket.emit('computationConfig', STATE.config[socket.appName]);
        ResultUtils.sendPendingVerificationsToAllWorkers(STATE,socket,decodedToken.numOfCpus)
        if(STATE.config[socket.appName].includesInputData){
            DataUtils.sendInputDataToWorkers(STATE,socket,decodedToken.numOfCpus)
        }
    }
    socket.on('results', (results) => {
        resultsCount++;
        const now = new Date().getTime();
        const lastTime = socket.times[results.workerNum] || now;
        socket.times[results.workerNum] = now;
        if(socket.times[results.workerNum] != lastTime && socket.times[results.workerNum]-lastTime<socket.bestTime){
            socket.bestTime = socket.times[results.workerNum]-lastTime
        }
        socket.emit('adaptiveSchedule',socket.bestTime/(socket.times[results.workerNum]-lastTime));
        const username = socket.povocopData ? socket.povocopData.povocopusername : 'anonymous'
        console.log('results',results)
        const needsVerification = STATE.redundancyFactors[socket.appName] != 0;
        const approved = !needsVerification;
        DBUtils.insertResult({
            username: username,
            appName: socket.appName,
            result: results,
            approved : approved,
            ip : socket.ip
        },function(result){
            const workerNum = results.workerNum;
            const connectedInputData = socket.inputData[workerNum];
            if(!connectedInputData){
                console.log(workerNum)
            }
            delete result.dataValues.ip;
            if(needsVerification){ResultUtils.newResultHandler(result.dataValues,STATE,socket,connectedInputData)}
            else{
                STATE.config[socket.appName].lastApprovedResult = {result: results, inputData: connectedInputData};
                socketEventsEmitter.emit('newConfig'+socket.appName);
            }
            if(STATE.config[socket.appName].includesInputData){
                DataUtils.removeAssignment(socket,results,result,connectedInputData);
                DataUtils.sendInputDataToSingleWorker(STATE,socket,results.workerNum)
            }
        })
    })
    socket.on('verified',(result)=>{ResultUtils.verifyHandler(result,STATE,socket)});

    let interval = setInterval(() => {
        if(!socket.povocopData){
            return
        }
        let strength = resultsCount - lastResultsCount;
        lastResultsCount = resultsCount;
        socket.povocopData.points+=strength;
        const tokenToSend = TokenUtils.updateToken(socket)
        socket.emit('token', tokenToSend);
    },120000)

    socket.on('disconnect',()=>{
        ResultUtils.handleInputDataReassignment({inputData : socket.inputData},socket, STATE);
        ResultUtils.handleResultVerificationReassignment({results : socket.results},socket, STATE);
        console.log("disconnected!",socket.povocopData ? socket.povocopData.povocopusername : 'anonymous',socket.id)
        clearInterval(interval);
        interval = null;
        STATE.socketMap[socket.appName] = STATE.socketMap[socket.appName].filter(item => item.id !== socket.id)
        delete STATE.usersOnline[socket.povocopData && socket.povocopData.uuid];
    })
}