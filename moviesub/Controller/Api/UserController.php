<?php
class UserController extends BaseController
{
    /** 
* "/user/list" Endpoint - Get list of users 
*/
    public function listAction()
    {
        $strErrorDesc = '';
        $requestMethod = $_SERVER["REQUEST_METHOD"];

        $arrQueryStringParams = $this->getQueryStringParams();
        if (strtoupper($requestMethod) == 'GET') {
            try {
                $userModel = new UserModel();
                $intLimit = 10;
                if (isset($arrQueryStringParams['limit']) && $arrQueryStringParams['limit']) {
                    $intLimit = $arrQueryStringParams['limit'];
                }
                $arrUsers = $userModel->getUsers($intLimit);

                $responseData = json_encode($arrUsers);
            } catch (Error $e) {
                $strErrorDesc = $e->getMessage().'Something went wrong! Please contact support.';
                $strErrorHeader = 'HTTP/1.1 500 Internal Server Error';
            }
        } else {
            $strErrorDesc = 'Method not supported';
            $strErrorHeader = 'HTTP/1.1 422 Unprocessable Entity';
        }
        // send output 
        if (!$strErrorDesc) {
            $this->sendOutput(
                $responseData,
                array('Content-Type: application/json', 'HTTP/1.1 200 OK')
            );
        } else {
            $this->sendOutput(json_encode(array('error' => $strErrorDesc)), 
                array('Content-Type: application/json', $strErrorHeader)
            );
        }
    }

    public function getSubscriptionHistory()
    {
        $user_id = 1;
        $strErrorDesc = '';
        $requestMethod = $_SERVER["REQUEST_METHOD"];

        $arrQueryStringParams = $this->getQueryStringParams();
        if (strtoupper($requestMethod) == 'GET') {
            try {
                $subscriptionModel = new Subscription();
                
                $arrSubs = $subscriptionModel->getSubscription($user_id);

                

                $apiUrl = "https://dummyapi.online/api/movies";
                $ch = curl_init($apiUrl); 
                curl_setopt($ch, CURLOPT_RETURNTRANSFER, true); 
                curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false); 
                $responseApi  = curl_exec($ch);
                curl_close($ch);
                $responseApi = json_decode($responseApi);
                // echo var_dump($responseApi);
                $movieMap = [];
                foreach ($responseApi as $movie) {
                    $movieMap[$movie->id] = $movie;

                }

                
                $movieWithSubscription = [];
                foreach ($arrSubs as $subscriptionData) {
                    $movieId = $subscriptionData['movie_id'];
                    if (isset($movieMap[$movieId])) {
                        $movie = $movieMap[$movieId];
                        $subscriptionData['movie'] = $movie; // Add the user information to the order
                        $movieWithSubscription[] = $subscriptionData;
                    }
                }
                $responseData = json_encode($movieWithSubscription);
                
            } catch (Error $e) {
                $strErrorDesc = $e->getMessage().'Something went wrong! Please contact support.';
                $strErrorHeader = 'HTTP/1.1 500 Internal Server Error';
            }
        } else {
            $strErrorDesc = 'Method not supported';
            $strErrorHeader = 'HTTP/1.1 422 Unprocessable Entity';
        }
        // send output 
        if (!$strErrorDesc) {
            $this->sendOutput(
                $responseData,
                array('Content-Type: application/json', 'HTTP/1.1 200 OK')
            );
        } else {
            $this->sendOutput(json_encode(array('error' => $strErrorDesc)), 
                array('Content-Type: application/json', $strErrorHeader)
            );
        }

    }

    public function removeSubscription(){
        $user_id = 1;
        $subscription_id = 1;
        $strErrorDesc = '';
        $requestMethod = $_SERVER["REQUEST_METHOD"];

        $arrQueryStringParams = $this->getQueryStringParams();
        if (strtoupper($requestMethod) == 'PUT') {
            try {
                $subscriptionModel = new Subscription();
                
                $arrSubs = $subscriptionModel->removeSubscription($user_id, $subscription_id);
                $responseData = [];
                $responseData['msg'] = 'Unsubscribed Successfully';
                
                
            } catch (Error $e) {
                $strErrorDesc = $e->getMessage().'Something went wrong! Please contact support.';
                $strErrorHeader = 'HTTP/1.1 500 Internal Server Error';
            }
        } else {
            $strErrorDesc = 'Method not supported';
            $strErrorHeader = 'HTTP/1.1 422 Unprocessable Entity';
        }
        // send output 
        if (!$strErrorDesc) {
            $this->sendOutput(
                $responseData,
                array('Content-Type: application/json', 'HTTP/1.1 200 OK')
            );
        } else {
            $this->sendOutput(json_encode(array('error' => $strErrorDesc)), 
                array('Content-Type: application/json', $strErrorHeader)
            );
        }

    }
}