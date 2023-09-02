<?php
require __DIR__ . "/inc/bootstrap.php";
// $uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
// $uri = explode( '/', $uri );
$request = $_SERVER['REQUEST_URI'];
// if ((isset($uri[1]) && $uri[1] != 'user') || !isset($uri[2])) {
//     header("HTTP/1.1 404 Not Found");
//     exit();
// }
require PROJECT_ROOT_PATH . "/Controller/Api/UserController.php";
$objFeedController = new UserController();
switch ($request) {
    case '/user/list':
    $strMethodName = 'listAction';
    $objFeedController->{$strMethodName}();
    break;

    case '/get-subscription-history':

    $objFeedController->getSubscriptionHistory();
    break;

    case '/unsubscribe-movie':

    $objFeedController->removeSubscription();
    break;

}    
?>