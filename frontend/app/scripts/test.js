function doCalculations(){
  var iterationCount = 1000000;
  var start = new Date().getTime();
  var res = 1;
  while (iterationCount>0 && res>0) {
    res = iterationCount%13+iterationCount/2+iterationCount+1+new Date().getTime();
    iterationCount--;
  }
  var end =  new Date().getTime();
  self.postMessage({
      time: start-end
  });
}


self.onmessage = function(e) {
  doCalculations(e.data);
}
